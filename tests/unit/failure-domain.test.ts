/**
 * The refusal contract: local backpressure must be distinguishable from
 * upstream exhaustion.
 *
 * The bug: `thinGateway` answered "every provider is dead" with 503 +
 * `Retry-After: 5`, and `server-elysia`'s admission controller answered "my
 * queue is full" with 503 + `Retry-After: 5`. Byte-identical. A client could
 * not tell "back off, I am busy" (retrying works) from "there is nothing left
 * to try" (retrying burns another 60s budget re-proving it).
 *
 * See src/server/headless/failureDomain.ts for the status-code reasoning.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  failureResponse,
  buildFailureBody,
  failureHeaders,
  failureDomainOf,
  statusForFailure,
  LOCAL_RETRY_AFTER_SECONDS,
} = await import("@/server/headless/failureDomain");

test("upstream exhaustion and local backpressure no longer share a status", () => {
  // This is the regression. Both were 503 before.
  assert.notEqual(
    statusForFailure("upstream_pool_exhausted"),
    statusForFailure("admission_queue_full")
  );
});

test("upstream exhaustion is 502 — we are a gateway and every inbound server refused", () => {
  assert.equal(statusForFailure("upstream_pool_exhausted"), 502);
  assert.equal(statusForFailure("upstream_no_eligible_target"), 502);
  assert.equal(failureDomainOf("upstream_pool_exhausted"), "upstream");
});

test("local admission control keeps 503 — the textbook temporary-overload code", () => {
  assert.equal(statusForFailure("admission_queue_full"), 503);
  assert.equal(statusForFailure("admission_queue_timeout"), 503);
  assert.equal(failureDomainOf("admission_queue_full"), "local");
});

test("a client that hung up is 499, not a server error", () => {
  assert.equal(statusForFailure("client_disconnected"), 499);
  assert.equal(failureDomainOf("client_disconnected"), "client");
});

test("NOTHING is 429 — a rate-limit-shaped answer must never be given for an upstream reason", () => {
  // The user's stated expectation: OmniRoute must not surface rate-limit-shaped
  // failures for upstream reasons. 429 means "you sent too many requests", and
  // in the upstream case the caller did nothing wrong.
  for (const code of [
    "upstream_pool_exhausted",
    "upstream_no_eligible_target",
    "admission_queue_full",
    "admission_queue_timeout",
    "client_disconnected",
  ] as const) {
    assert.notEqual(statusForFailure(code), 429, `${code} must not be 429`);
  }
});

test("Retry-After is promised ONLY where waiting actually helps", () => {
  // Local overload genuinely clears in seconds, so the promise is honest.
  assert.equal(
    failureHeaders("admission_queue_full")["Retry-After"],
    String(LOCAL_RETRY_AFTER_SECONDS)
  );
  assert.equal(
    failureHeaders("admission_queue_timeout")["Retry-After"],
    String(LOCAL_RETRY_AFTER_SECONDS)
  );
  // Upstream exhaustion does not clear because the caller waited. Promising a
  // retry window here is what made an upstream failure read as throttling.
  assert.equal(failureHeaders("upstream_pool_exhausted")["Retry-After"], undefined);
  assert.equal(failureHeaders("upstream_no_eligible_target")["Retry-After"], undefined);
  assert.equal(failureHeaders("client_disconnected")["Retry-After"], undefined);
});

test("every refusal carries a machine-readable discriminator on headers and body", () => {
  const headers = failureHeaders("admission_queue_timeout");
  assert.equal(headers["x-omniroute-failure-domain"], "local");
  assert.equal(headers["x-omniroute-failure-code"], "admission_queue_timeout");

  const body = buildFailureBody("upstream_pool_exhausted", "everything is dead");
  assert.equal(body.error.code, "upstream_pool_exhausted");
  assert.equal(body.error.failure_domain, "upstream");
  assert.equal(body.error.type, "upstream_error");
  assert.equal(body.error.message, "everything is dead");
});

test("the two refusals are distinguishable end to end on a real Response", async () => {
  const upstream = failureResponse("upstream_pool_exhausted", "all providers exhausted");
  const local = failureResponse("admission_queue_full", "Queue full (500)");

  assert.equal(upstream.status, 502);
  assert.equal(local.status, 503);
  assert.equal(upstream.headers.get("x-omniroute-failure-domain"), "upstream");
  assert.equal(local.headers.get("x-omniroute-failure-domain"), "local");
  assert.equal(upstream.headers.get("retry-after"), null);
  assert.equal(local.headers.get("retry-after"), "5");

  const upstreamBody = (await upstream.json()) as { error: { code: string } };
  const localBody = (await local.json()) as { error: { code: string } };
  assert.notEqual(upstreamBody.error.code, localBody.error.code);
});

test("the emitted code has no doubled prefix", () => {
  // The old code built `queue_${reason}` over reasons that already began with
  // "queue-", emitting "queue_queue-full".
  for (const code of ["admission_queue_full", "admission_queue_timeout"] as const) {
    assert.equal(buildFailureBody(code, "x").error.code, code);
    assert.ok(!code.includes("queue_queue"));
  }
});
