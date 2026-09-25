/**
 * The refusal contract — telling "I am busy" apart from "there is nothing left to try".
 *
 * ## The problem this fixes
 *
 * Both of OmniRoute's refusal paths used to answer `503` with `Retry-After: 5`:
 *
 *   - `thinGateway` when every provider/model/credential had been tried and
 *     refused (upstream exhaustion), and
 *   - `server-elysia`'s admission controller when its own concurrency queue was
 *     full or a caller waited past `OMNIROUTE_QUEUE_TIMEOUT_MS` (local
 *     backpressure).
 *
 * A client could not distinguish them, yet they call for opposite behaviour.
 * Local backpressure genuinely clears in seconds and retrying is correct.
 * Upstream exhaustion does not clear because the caller waited — retrying in
 * five seconds just spends another 60-second budget re-proving that every free
 * provider is still dead, which is exactly the retry storm the logs recorded.
 *
 * ## The status codes, and why these ones
 *
 * RFC 9110 already separates these two cases; the router simply was not using
 * the distinction.
 *
 *   - §15.6.4 `503 Service Unavailable` — "the server is currently unable to
 *     handle the request due to a temporary overload". That is *precisely* what
 *     local admission control is, and `Retry-After` is defined for exactly this
 *     case. LOCAL backpressure therefore keeps 503 + Retry-After.
 *
 *   - §15.6.3 `502 Bad Gateway` — "the server, while acting as a gateway or
 *     proxy, received an invalid response from an inbound server". OmniRoute is
 *     a gateway and every inbound server refused, so UPSTREAM exhaustion is 502.
 *     It carries no `Retry-After`: the router has no basis to promise that
 *     waitingN seconds changes anything, and inventing one is what made an
 *     upstream failure read to clients as though OmniRoute were throttling them.
 *
 * `429 Too Many Requests` is deliberately used for NEITHER. It means the caller
 * sent too many requests. In the upstream case the caller did nothing wrong —
 * surfacing a rate-limit-shaped failure for an upstream reason is the specific
 * behaviour this contract exists to prevent. In the local case the limiter is a
 * bounded work queue, not a per-client rate limit, so 503 is the honest code.
 *
 *   - `499` for a client that disconnected while queued. Nothing failed; the
 *     caller left. Matches the 499 `thinGateway` already returns for a mid-flight
 *     disconnect, and keeps client aborts out of the server-error statistics.
 *
 * ## The machine-readable discriminator
 *
 * Status alone is a coarse signal and proxies rewrite it, so every refusal also
 * carries, on both the body and the headers:
 *
 *   - `x-omniroute-failure-domain: upstream | local | client`
 *   - `error.code`: a stable enumerated string (see `FailureCode`)
 *   - `error.type`: `upstream_error` | `server_error` | `client_closed_request`
 *
 * Clients should branch on `x-omniroute-failure-domain` / `error.code`, never on
 * the status line alone.
 */

/** Who is responsible for the refusal. */
export type FailureDomain =
  /** Every upstream provider/model/credential was tried and refused. */
  | "upstream"
  /** OmniRoute's own admission control refused to start the work. */
  | "local"
  /** The caller went away before the work could start or finish. */
  | "client";

/** Stable, enumerated refusal codes. Clients may switch on these. */
export type FailureCode =
  /** Upstream: the candidate pool was tried to exhaustion. */
  | "upstream_pool_exhausted"
  /** Upstream: no candidate was even eligible (all cooling down / too small). */
  | "upstream_no_eligible_target"
  /** Local: the admission queue was already at OMNIROUTE_MAX_QUEUE_DEPTH. */
  | "admission_queue_full"
  /** Local: waited past OMNIROUTE_QUEUE_TIMEOUT_MS for a concurrency slot. */
  | "admission_queue_timeout"
  /** Client: disconnected while waiting for a slot. */
  | "client_disconnected";

const DOMAIN_OF: Record<FailureCode, FailureDomain> = {
  upstream_pool_exhausted: "upstream",
  upstream_no_eligible_target: "upstream",
  admission_queue_full: "local",
  admission_queue_timeout: "local",
  client_disconnected: "client",
};

const STATUS_OF: Record<FailureCode, number> = {
  // 502: we are a gateway and every inbound server refused. No Retry-After —
  // see the header note above.
  upstream_pool_exhausted: 502,
  upstream_no_eligible_target: 502,
  // 503: temporary local overload, the textbook case for 503 + Retry-After.
  admission_queue_full: 503,
  admission_queue_timeout: 503,
  // 499: the caller hung up. Not a server failure.
  client_disconnected: 499,
};

const TYPE_OF: Record<FailureDomain, string> = {
  upstream: "upstream_error",
  local: "server_error",
  client: "client_closed_request",
};

/** Seconds to advertise in `Retry-After`, for LOCAL backpressure only. */
export const LOCAL_RETRY_AFTER_SECONDS = 5;

export function failureDomainOf(code: FailureCode): FailureDomain {
  return DOMAIN_OF[code];
}

export function statusForFailure(code: FailureCode): number {
  return STATUS_OF[code];
}

export interface FailureResponseBody {
  error: {
    message: string;
    type: string;
    code: FailureCode;
    /** Duplicated into the body so non-header-aware clients can branch too. */
    failure_domain: FailureDomain;
  };
}

export function buildFailureBody(code: FailureCode, message: string): FailureResponseBody {
  const domain = failureDomainOf(code);
  return { error: { message, type: TYPE_OF[domain], code, failure_domain: domain } };
}

export function failureHeaders(code: FailureCode): Record<string, string> {
  const domain = failureDomainOf(code);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-omniroute-failure-domain": domain,
    "x-omniroute-failure-code": code,
  };
  // Retry-After is a promise that waiting helps. Only local backpressure can
  // honestly make it.
  if (domain === "local") headers["Retry-After"] = String(LOCAL_RETRY_AFTER_SECONDS);
  return headers;
}

/** Build the complete refusal `Response` for an enumerated failure code. */
export function failureResponse(code: FailureCode, message: string): Response {
  return new Response(JSON.stringify(buildFailureBody(code, message)), {
    status: statusForFailure(code),
    headers: failureHeaders(code),
  });
}
