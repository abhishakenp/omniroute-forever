/**
 * Thin gateway handler — replaces the combo routing engine.
 *
 * Architecture:
 *   Request → SQLite iterator (one provider/model/apikey at a time)
 *   → fetch upstream → pipe bytes to client
 *   → fail? mark in SQLite, next iteration
 *   → exhausted? trigger provisioner, wait for new key, retry
 *
 * Zero in-memory state. Zero caching. Zero TransformStream buffers.
 * One target at a time. Pipe upstream→client directly.
 */

import { TargetIterator, type TargetRow } from "../../lib/db/targetIterator.ts";
import { getProviderRegistry } from "../../../open-sse/services/autoCombo/providerRegistryAccessor.ts";
import { errorResponse } from "../../../open-sse/utils/error.ts";
import { failureResponse } from "./failureDomain.ts";
import {
  triggerProviderProvisioning,
  deleteProvisionerAccount,
  isProvisioningUnderway,
} from "../../sse/services/provisionerHook.ts";
import { getExecutor, hasSpecializedExecutor } from "../../../open-sse/executors/index.ts";
import type { RegistryEntry } from "../../../open-sse/config/providers/shared.ts";
import { estimatePromptTokens, requestedOutputTokens } from "../../lib/db/modelFitness.ts";
import { recordTokenRefusal } from "../../lib/db/targetIterator.ts";
import { recordModelIncapable, isModelIncapableRefusal } from "../../lib/db/keylessHealth.ts";
import * as log from "../../sse/utils/logger";
import {
  guardToolCallStream,
  needsToolPlanning,
  planToolTargets,
  recordToolOutcome,
  requestHasTools,
  requestKey,
} from "./toolCallGuard.ts";

/**
 * ─── the store seam ────────────────────────────────────────────────────────
 *
 * This router used to name SQLite in five places: it constructed a
 * `TargetIterator` twice, opened a raw `getDbInstance().prepare(...)` to ask
 * which providers were rate limited, and reached for the handle again to record
 * the two things it learns from a refusal. Every one of those is a question
 * about *connections*, not about SQLite, and none of them had any business
 * knowing which store answered.
 *
 * So they are four methods on `RouterStore` now, and the default implementation
 * below is the same SQLite code, moved rather than rewritten. **Nothing about
 * the live path changes**: `server-elysia.ts` installs nothing, so it gets
 * `sqliteStore`, which does exactly what the inline code did, in the same
 * order, with the same lazy `import()` of `core.ts` that keeps `DATA_DIR`
 * resolvable after a host has set it.
 *
 * What it buys is that a host *may* install something else — and the cordis
 * gateway row does, handing over `ctx.db`. That is the whole of Scope 8: the
 * seam is only a seam if the consumer actually goes through it.
 *
 * The cursor type is declared structurally rather than imported from
 * `@omniroute/db`, deliberately. `src/` must not depend on `packages/`: the
 * live launchd job boots `server-elysia.ts` out of `src/`, and giving it an
 * import into a package tree that only the cordis branch has would make the
 * production entrypoint unbootable the first time the two diverged.
 */
export interface TargetCursorLike {
  nextTarget(): TargetRow | null;
  markFailed(connectionId: string, status: number, cooldownMs?: number): void;
  markSucceeded(connectionId: string): void;
  readonly triedProviders: Set<string>;
}

export interface TargetQueryLike {
  freeProvidersOnly?: boolean;
  specificProvider?: string;
  specificModel?: string;
  promptTokens?: number;
  outputTokens?: number;
  reservedFor?: string;
}

export interface RouterStore {
  createTargetCursor(query: TargetQueryLike): TargetCursorLike;
  rateLimitedProviders(): Promise<string[]>;
  recordTokenRefusal(modelStr: string, promptTokens: number): Promise<void>;
  recordModelIncapable(modelStr: string, reason: string): Promise<void>;
}

/** The store this file has always used, unchanged, now behind a name. */
const sqliteStore: RouterStore = {
  createTargetCursor: (query) => new TargetIterator(query),
  rateLimitedProviders: async () => {
    const { getDbInstance } = await import("../../lib/db/core.ts");
    const rows = getDbInstance()
      .prepare(
        `SELECT DISTINCT provider FROM provider_connections
         WHERE is_active = 1 AND rate_limited_until IS NOT NULL`
      )
      .all() as Array<{ provider: string }>;
    return rows.map((r) => r.provider).filter(Boolean);
  },
  recordTokenRefusal: async (modelStr, promptTokens) => {
    const { getDbInstance } = await import("../../lib/db/core.ts");
    recordTokenRefusal(getDbInstance(), modelStr, promptTokens);
  },
  recordModelIncapable: async (modelStr, reason) => {
    const { getDbInstance } = await import("../../lib/db/core.ts");
    recordModelIncapable(getDbInstance(), modelStr, reason);
  },
};

let installedStore: RouterStore | null = null;

/**
 * Point the router at a store.
 *
 * Returns the undo, rather than exposing a `clear()`: a host that installs one
 * during `Service.init` needs to put back exactly what was there when it
 * unloads, and "exactly what was there" is not always the default — during a
 * hot-swap two rows are briefly alive at once, and a clear() would leave the
 * survivor pointing at SQLite.
 */
export function setRouterStore(store: RouterStore): () => void {
  const previous = installedStore;
  installedStore = store;
  return () => {
    // Only stand down if nobody has installed over us since; otherwise the
    // successor's store would be replaced by our predecessor's on our unload,
    // which is the exact reload-ordering bug this shape exists to avoid.
    if (installedStore === store) installedStore = previous;
  };
}

/** Whoever is installed, else SQLite. Never null — a router with no store cannot route. */
export function getRouterStore(): RouterStore {
  return installedStore ?? sqliteStore;
}


// NOTE: a hardcoded FREE_PROVIDERS set used to live here, unreferenced. It was
// also wrong — it omitted dahl, llm7, uncloseai and bazaarlink, all free and all
// in active service. The free-provider set is now derived from the provider
// catalog's `hasFree` flag unioned with the registry's keyless providers; see
// getFreeProviderIds() in src/lib/db/targetIterator.ts, which TargetIterator
// applies when `freeProvidersOnly` is set.

// Providers that need custom request formats (not standard OpenAI Bearer auth)
// and don't yet have a specialized executor registered. Providers WITH
// specialized executors (auggie, felo-web, duckduckgo-web) are handled via
// the executor delegation path in tryTarget() below.
const SKIP_PROVIDERS = new Set([
  "aihorde", // needs API key header, not Bearer
]);

/**
 * Consumer namespaces that are RESERVED ALIASES, not provider/model pairs.
 *
 * "iris/always" names the consumer asking, not an upstream: parsed as
 * provider/model it would look for a provider called "iris" and match
 * nothing. A request on one of these prefixes routes against the whole pool
 * with `reservedFor` set, so keys reserved for that consumer are tried first
 * and the general pool is the fallback. Adding another consumer (e.g.
 * "rlm/") is one entry here.
 */
const RESERVED_ALIAS_PREFIXES = ["iris/"];

/**
 * How much of an upstream error body to read.
 *
 * Both error paths used to `await response.text()` and only then `.slice(0, 200)`
 * — materialising the entire body before throwing almost all of it away. On the
 * measured traffic that is ~128k error bodies read in full to keep 200 bytes,
 * and a provider that answers an error with a megabyte of HTML is read in full
 * too. Read a bounded prefix and drop the rest.
 */
const MAX_ERROR_BODY_BYTES = 2048;

async function readBoundedErrorBody(response: Response): Promise<string> {
  try {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
    // Stop pulling the rest of the body over the wire.
    await reader.cancel().catch(() => {});
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(joined.slice(0, MAX_ERROR_BODY_BYTES));
  } catch {
    return "";
  }
}

/**
 * Why a candidate refused, in a few words a human can act on.
 *
 * `503 ... tried: cohere/x (400), cohere/y (400)` says nothing — the operator
 * cannot tell an out-of-credit pool from a prompt no free model can hold. The
 * reason is already in the body; it just was not being carried.
 */
function refusalReason(status: number, message: string): string {
  const body = message.toLowerCase();
  if (
    body.includes("too_many_tokens") ||
    body.includes("context length") ||
    body.includes("context window") ||
    status === 413
  ) {
    return "prompt too large";
  }
  if (body.includes("trial key")) return "trial-key rate limit";
  if (status === 429) return "rate limited";
  if (body.includes("is not supported") || body.includes("invalid request: model"))
    return "model cannot chat";
  if (status === 401 || status === 403) return "auth rejected";
  if (status === 402) return "out of credit";
  if (status === 504) return "timeout";
  if (status >= 500) return "upstream error";
  return `HTTP ${status}`;
}

/** Statuses that mean "this model will refuse a prompt this size again". */
function isTokenRefusal(status: number, message: string): boolean {
  const body = message.toLowerCase();
  return (
    status === 413 ||
    (status === 400 &&
      (body.includes("too_many_tokens") ||
        body.includes("context length") ||
        body.includes("context window") ||
        body.includes("too long")))
  );
}

// Per-target fetch timeout — headers must arrive within this window.
const TARGET_TIMEOUT_MS = 15_000;
// Total budget for all retries before giving up.
const TOTAL_BUDGET_MS = 60_000;
// Cooldown to set on 429 (1 minute — provider refreshes quickly).
const RATE_LIMIT_COOLDOWN_MS = 60_000;
// How long to wait for provisioner to produce a new key.
const PROVISIONER_WAIT_MS = 30_000;

// Providers whose free tiers reset on a long clock (hourly/daily), not per
// request. A 60s cooldown on these produced thousands of doomed retries in
// the logs — the provider is still rate-limited 60s later, so the next
// request tries it again and fails again. Use a longer cooldown that matches
// the actual reset window.
const LONG_RESET_PROVIDERS = new Set([
  "dahl", // free tier resets on a daily clock
  "felo-web", // thread creation rate-limited for long windows
  "duckduckgo-web", // VQD token acquisition rate-limited
  "mistral", // daily token quota
  "llm", // daily token quota (codestral)
  "uncloseai", // context length refusals are permanent per model
]);
const LONG_RESET_COOLDOWN_MS = 5 * 60_000; // 5 min — matches observed reset windows

function rateLimitCooldown(provider: string): number {
  return LONG_RESET_PROVIDERS.has(provider) ? LONG_RESET_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
}

interface GatewayRequest {
  body: Record<string, unknown>;
  model: string; // "auto/best-free" or "provider/model"
  stream: boolean;
  signal?: AbortSignal;
}

/**
 * Handle a chat completions request using the iterator pattern.
 * Returns a Response — either success (streaming or non-streaming) or error.
 */
export async function handleThinGateway(req: GatewayRequest): Promise<Response> {
  const startTime = Date.now();
  const isAuto = req.model.startsWith("auto/");
  const isFreeOnly = req.model === "auto/best-free" || req.model.includes(":free");
  // A reserved alias ("iris/always") is a consumer tag, not a provider/model
  // pair. Without this it would parse as provider "iris", model "always",
  // which matches nothing and fails the request outright.
  const reservedAlias = RESERVED_ALIAS_PREFIXES.some((prefix) => req.model.startsWith(prefix))
    ? req.model
    : undefined;
  const isAutoOrReserved = isAuto || !!reservedAlias;

  // For direct provider/model requests (e.g. "mistral/mistral-large-latest"),
  // create an iterator scoped to that specific provider+model.
  // For auto/* requests, use the full iterator.
  let specificProvider: string | undefined;
  let specificModel: string | undefined;
  if (!isAutoOrReserved) {
    const slashIdx = req.model.indexOf("/");
    if (slashIdx > 0) {
      specificProvider = req.model.slice(0, slashIdx);
      specificModel = req.model.slice(slashIdx + 1);
    }
  }

  // Size the request once. Nothing downstream could previously tell a 200-token
  // ping from a 7,500-token reviewer prompt, so both got the same candidate
  // list — which is why the small one succeeded and the large one did not.
  const promptTokens = estimatePromptTokens(req.body);
  const outputTokens = requestedOutputTokens(req.body);

  // Every question this handler asks about connections goes through here.
  const store = getRouterStore();
  const iterator = store.createTargetCursor({
    freeProvidersOnly: isFreeOnly,
    specificProvider,
    specificModel,
    promptTokens,
    outputTokens,
    reservedFor: reservedAlias,
  });

  const registry = getProviderRegistry();
  let attempts = 0;
  const errors: Array<{ model: string; status: number; message: string }> = [];
  // Streamed tool requests are watched for swallowed tool calls. A client's
  // retry of one that dropped may be re-planned onto a model with a better
  // measured tool success rate. See toolCallGuard.ts for the measurements.
  // OMNIROUTE_TOOL_GUARD=0 turns all of it off (ops escape hatch).
  const needsTools = process.env.OMNIROUTE_TOOL_GUARD !== "0" && req.stream && requestHasTools(req.body);
  const toolKey = needsTools ? requestKey(req.body) : "";
  let planned: TargetRow[] | null = null;
  if (needsTools && needsToolPlanning(toolKey)) {
    // nextTarget() only advances this cursor's in-memory "tried" sets, so
    // reading ahead to reorder is safe. Bounded: the pool is ~20 models.
    const all: TargetRow[] = [];
    for (let t = iterator.nextTarget(); t && all.length < 64; t = iterator.nextTarget()) all.push(t);
    planned = planToolTargets(all, toolKey);
    log.info(
      "thin-gateway",
      `retry of a dropped tool call planned: ${[...new Set(planned.map((t) => t.modelStr))].slice(0, 3).join(" → ")}`
    );
  }
  const guard = (response: Response, modelStr: string) =>
    needsTools ? withToolCallGuard(response, modelStr, toolKey) : response;

  while (Date.now() - startTime < TOTAL_BUDGET_MS) {
    const target = planned ? (planned.shift() ?? null) : iterator.nextTarget();
    if (!target) {
      // All targets exhausted — trigger provisioner for both tried providers
      // AND rate-limited credentialed providers (which were never attempted).
      const providersToProvision = new Set(iterator.triedProviders);
      // Query SQLite for rate-limited credentialed providers
      try {
        for (const provider of await store.rateLimitedProviders()) {
          if (!SKIP_PROVIDERS.has(provider)) providersToProvision.add(provider);
        }
      } catch {
        // ignore store errors
      }

      if (providersToProvision.size > 0) {
        // Only wait if replenishment is ACTUALLY under way. Previously this
        // slept PROVISIONER_WAIT_MS (30s) unconditionally — half of the 60s
        // TOTAL_BUDGET_MS — even when every single trigger was a no-op because
        // the provider was inside its 30s cooldown, blacklisted, or already
        // in flight. Across 4,748 exhaustion events that is up to 30s of held
        // connection per request buying nothing, and it is why an exhaustion
        // storm looked like the provisioner being "throttled out": the storm
        // did trigger replenishment once, then every subsequent request in the
        // cooldown window paid the full sleep for a trigger that never fired.
        const started: string[] = [];
        const suppressed: string[] = [];
        for (const provider of providersToProvision) {
          const outcome = triggerProviderProvisioning(provider);
          (isProvisioningUnderway(outcome) ? started : suppressed).push(`${provider}:${outcome}`);
        }
        log.info(
          "thin-gateway",
          `All targets exhausted (${attempts} attempts) — provisioning underway for [${started.join(", ") || "none"}]` +
            (suppressed.length ? `; suppressed [${suppressed.join(", ")}]` : "")
        );

        if (started.length === 0) {
          // Nothing is being provisioned, so no new key can arrive. Waiting is
          // pure latency. Fall through to the 503 immediately.
          break;
        }

        // Wait for the provisioner to produce a new key — but never past the
        // request's own budget, and never longer than the remaining budget.
        const remainingBudget = TOTAL_BUDGET_MS - (Date.now() - startTime);
        const waitMs = Math.min(PROVISIONER_WAIT_MS, Math.max(0, remainingBudget));
        if (waitMs <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // Try once more with fresh iterator (new keys may have been inserted).
        // The pin MUST be carried over: this path used to drop
        // specificProvider/specificModel, so a request for `cohere/command-a`
        // whose cohere targets were exhausted came back answered by
        // dahl/MiniMax — a different provider and a different model than the
        // caller asked for, reported as a success.
        const freshIter = store.createTargetCursor({
          freeProvidersOnly: isFreeOnly,
          specificProvider,
          specificModel,
          promptTokens,
          outputTokens,
          reservedFor: reservedAlias,
        });
        const freshTarget = freshIter.nextTarget();
        if (freshTarget) {
          const result = await tryTarget(freshTarget, req, registry);
          if (result.ok) {
            freshIter.markSucceeded(freshTarget.connectionId);
            return guard(result.response, freshTarget.modelStr);
          }
        }
      }
      break;
    }

    attempts++;
    log.debug(
      "thin-gateway",
      `Attempt ${attempts}: ${target.modelStr} conn=${target.connectionId.slice(0, 8)}`
    );
    const result = await tryTarget(target, req, registry);
    if (result.ok) {
      log.debug("thin-gateway", `✓ ${target.modelStr} succeeded`);
      iterator.markSucceeded(target.connectionId);
      return guard(result.response, target.modelStr);
    }

    // TS doesn't narrow literal-true/false unions after `if (result.ok) return`
    // in this config, so narrow manually with a type guard.
    const fail = result as { ok: false; status: number; message: string }
    const failStatus = fail.status
    const failMessage = fail.message

    log.debug(
      "thin-gateway",
      `✗ ${target.modelStr} failed: ${failStatus} ${failMessage.slice(0, 80)}`
    );
    errors.push({ model: target.modelStr, status: failStatus, message: failMessage });

    // A prompt-too-large refusal is a fact about this model, not this moment.
    // Record it so the same model is not offered the same size again.
    if (isTokenRefusal(failStatus, failMessage) && promptTokens > 0) {
      try {
        await store.recordTokenRefusal(target.modelStr, promptTokens);
      } catch {
        // Learning is an optimisation, never a failure path.
      }
    }

    // "invalid request: model 'X'" is a fact about the model too, and a
    // permanent one — X is not a chat model and never will be. refusalReason()
    // has always CLASSIFIED this as "model cannot chat", but the classification
    // only decorated the final error message; the target stayed in the pool and
    // was offered again next request. Measured: 8,913 identical 400s for
    // cohere/cohere-transcribe-03-2026, a speech-to-text model that discovery
    // imported into the chat catalogue. Record it so it is never offered again.
    if (isModelIncapableRefusal(failStatus, failMessage)) {
      try {
        await store.recordModelIncapable(target.modelStr, failMessage.slice(0, 200));
        log.info(
          "thin-gateway",
          `${target.modelStr} permanently retired from the chat pool: upstream says it cannot chat`
        );
      } catch {
        // Learning is an optimisation, never a failure path.
      }
    }

    iterator.markFailed(target.connectionId, failStatus, rateLimitCooldown(target.provider));

    // A 402 (insufficient credits) or 401/403 (auth rejected) means the
    // account is permanently dead — not rate-limited. Ask the provisioner to
    // forget it and re-provision a replacement. The LOCAL retirement of this
    // credential already happened above, inside iterator.markFailed(); this
    // call only reaches the external provisioner.
    //
    // The outcome is no longer discarded. `.catch(() => {})` here meant a
    // provisioner that answered 500 — or was not running at all — looked
    // exactly like a successful delete, so a credential OmniRoute had given up
    // on kept being re-issued with nobody able to see why.
    if ((failStatus === 402 || failStatus === 401 || failStatus === 403) && target.apiKey) {
      void deleteProvisionerAccount(target.provider, target.apiKey, target.connectionId).then(
        (outcome) => {
          if (!outcome.ok) {
            log.warn(
              "thin-gateway",
              `Provisioner still holds dead credential ${target.provider} conn=${target.connectionId}: ` +
                `${outcome.reason} after ${outcome.attempts} attempt(s)`
            );
          }
        },
        (err: unknown) => {
          // deleteProvisionerAccount already handles its own errors; this guard
          // exists so an unexpected throw cannot become an unhandled rejection.
          log.warn(
            "thin-gateway",
            `Provisioner delete threw for ${target.provider} conn=${target.connectionId}: ` +
              (err instanceof Error ? err.message : "unknown")
          );
        }
      );
    }

    // Client disconnect check
    if (req.signal?.aborted) {
      return errorResponse(499, "Client disconnected");
    }
  }

  // All attempts failed
  const elapsed = Date.now() - startTime;
  // Say WHICH models were tried and WHY each refused. A bare list of status
  // codes cannot distinguish "the pool is out of credit" from "no free model
  // can hold this prompt", and those need opposite responses from the caller.
  const summary = errors
    .slice(0, 8)
    .map((e) => `${e.model} (${e.status} ${refusalReason(e.status, e.message)})`)
    .join(", ");
  const sized = promptTokens > 0 ? ` | prompt ~${promptTokens} tokens` : "";
  const overflowed = errors.length > 8 ? `... (+${errors.length - 8})` : "";
  const nothingTried =
    attempts === 0
      ? " | no candidate model was eligible — every free target is cooling down, out of quota, or too small for this prompt"
      : "";
  // Upstream exhaustion, NOT local backpressure. This used to be a bare 503
  // with Retry-After: 5 — byte-identical to the admission controller's refusal,
  // so a client could not tell "OmniRoute is busy, back off" from "every
  // provider is dead, backing off changes nothing". See failureDomain.ts for
  // the status choice (502) and the machine-readable discriminator.
  return failureResponse(
    attempts === 0 ? "upstream_no_eligible_target" : "upstream_pool_exhausted",
    `All providers exhausted after ${attempts} attempts (${elapsed}ms)${sized} | tried: ${summary}${overflowed}${nothingTried}`
  );
}

/**
 * Watch a streamed tool response for a swallowed call. On a drop the stream
 * ends with an error event (the client retries) and the model cools down for
 * tool requests, so that retry is routed to a different upstream.
 */
function withToolCallGuard(response: Response, modelStr: string, toolKey: string): Response {
  if (!response.body) return response;
  const body = guardToolCallStream(response.body, {
    modelStr,
    onToolCall: () => recordToolOutcome(modelStr, "tool"),
    onProse: () => recordToolOutcome(modelStr, "prose"),
    onDrop: (emptyRun) => {
      recordToolOutcome(modelStr, "drop", toolKey);
      log.warn(
        "thin-gateway",
        `${modelStr} dropped a tool call (${emptyRun} empty deltas) — stream cut; ` +
          `the client's retry may move to a model with a better tool success rate`
      );
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/**
 * Try a single target — fetch from upstream and pipe response to client.
 * Returns { ok: true, response } on success, { ok: false, status, message } on failure.
 */
async function tryTarget(
  target: TargetRow,
  req: GatewayRequest,
  registry: Record<string, RegistryEntry>
): Promise<{ ok: true; response: Response } | { ok: false; status: number; message: string }> {
  // Skip providers that need custom formats
  if (SKIP_PROVIDERS.has(target.provider)) {
    return { ok: false, status: 400, message: `Skipped provider: ${target.provider}` };
  }

  // ── Executor delegation path ────────────────────────────────────────
  // Providers with specialized executors (auggie, duckduckgo-web, felo-web, etc.)
  // have custom HTTP/stdio transports that don't fit the standard OpenAI
  // Bearer-auth fetch. Delegate to the executor's execute() method instead.
  // BUT: if the registry explicitly says executor="default", use the standard
  // fetch path (some providers like pollinations have a legacy executor that's
  // broken but their API is now plain OpenAI-compatible).
  const registryEntry = registry[target.provider];
  if (registryEntry?.executor !== "default" && hasSpecializedExecutor(target.provider)) {
    return await tryExecutorTarget(target, req);
  }

  const providerEntry = registryEntry;

  // Resolve the upstream base URL. Local providers (vllm, ollama-local,
  // lm-studio, llama-cpp, …) are NOT in the OpenSSE routing REGISTRY — they
  // live in LOCAL_PROVIDERS for the dashboard. Each connection carries its own
  // upstream URL in `provider_specific_data.baseUrl`, which the TargetIterator
  // surfaces as `target.baseUrl`. Prefer the connection-specific URL over the
  // registry's so a local provider routes even when no registry entry exists.
  const baseUrl = target.baseUrl || providerEntry?.baseUrl || providerEntry?.baseUrls?.[0];
  if (!baseUrl) {
    if (!providerEntry) {
      return { ok: false, status: 400, message: `Unknown provider: ${target.provider}` };
    }
    return { ok: false, status: 400, message: `No baseUrl for provider: ${target.provider}` };
  }

  // Skip non-HTTP providers (auggie uses stdio, duckduckgo/felo need custom formats)
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    return {
      ok: false,
      status: 400,
      message: `Non-HTTP provider: ${target.provider} (${baseUrl})`,
    };
  }

  // Build the upstream URL
  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  // Build request body — replace model, strip fields providers reject
  const upstreamBody: Record<string, unknown> = { ...req.body };
  upstreamBody.model = target.modelId;
  // Strip OpenAI-specific fields that other providers reject with 422
  delete upstreamBody.store;
  delete upstreamBody.logprobs;
  delete upstreamBody.top_logprobs;
  delete upstreamBody.service_tier;
  delete upstreamBody.prompt_cache_key;
  delete upstreamBody.user;
  // Mistral rejects parallel_tool_calls, reasoning_effort
  if (target.provider === "mistral") {
    delete upstreamBody.parallel_tool_calls;
    delete upstreamBody.reasoning_effort;
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // For "optional" authType, skip Authorization — use keyless access.
  // For "apikey" authType, send Bearer token (or X-API-Key if authHeader specifies it).
  // For "none" authType, never send Authorization.
  // When providerEntry is absent (local providers not in the routing REGISTRY),
  // fall back to Bearer if an API key was stored on the connection.
  const authType = providerEntry?.authType;
  if (target.apiKey && authType === "apikey") {
    if (providerEntry?.authHeader === "x-api-key") {
      headers["X-API-Key"] = target.apiKey;
    } else {
      headers["Authorization"] = `Bearer ${target.apiKey}`;
    }
  } else if (target.apiKey && !authType && authType !== "none") {
    // Default: send Bearer if authType is undefined (backwards compat)
    headers["Authorization"] = `Bearer ${target.apiKey}`;
  }

  // Fetch with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TARGET_TIMEOUT_MS);
  if (req.signal) {
    req.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!upstreamResponse.ok) {
      const errorText = await readBoundedErrorBody(upstreamResponse);
      return {
        ok: false,
        status: upstreamResponse.status,
        message: errorText.slice(0, 200) || `HTTP ${upstreamResponse.status}`,
      };
    }

    // Success — pipe upstream response body directly to client.
    // No TransformStream, no buffering, no chunk logging.
    // Just pass the bytes through.
    const responseHeaders = new Headers();
    // Copy content-type
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);

    // For streaming, pipe the body directly
    if (req.stream && upstreamResponse.body) {
      return {
        ok: true,
        response: new Response(upstreamResponse.body, {
          status: 200,
          headers: responseHeaders,
        }),
      };
    }

    // For non-streaming, read the body and return it
    const body = await upstreamResponse.text();
    responseHeaders.set("Content-Type", "application/json");
    return {
      ok: true,
      response: new Response(body, {
        status: 200,
        headers: responseHeaders,
      }),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: 504, message: "Target timeout" };
    }
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message.slice(0, 200) : "Fetch failed",
    };
  }
}

/**
 * The slice of an executor's `execute()` contract that the thin gateway relies
 * on. Executors return either a bare Response or a `{ response }` envelope.
 */
type ExecutorExecuteFn = (input: {
  model: string;
  body: unknown;
  stream: boolean;
  credentials: Record<string, unknown>;
  signal: AbortSignal | null;
}) => Promise<Response | { response: Response }>;

/**
 * Try a target via a specialized executor (auggie, duckduckgo-web, felo-web, etc.).
 * These providers have custom HTTP/stdio transports that don't fit the standard
 * OpenAI Bearer-auth fetch path. The executor's execute() method handles auth,
 * request formatting, and response translation to OpenAI format.
 */
async function tryExecutorTarget(
  target: TargetRow,
  req: GatewayRequest
): Promise<{ ok: true; response: Response } | { ok: false; status: number; message: string }> {
  try {
    const executor = getExecutor(target.provider);
    // The lazy executor index types `execute` as `unknown` so it never has to
    // import every executor's signature. Narrow it here — with a runtime guard,
    // not a blind cast — to the slice of the contract the gateway depends on.
    const execute = executor.execute as ExecutorExecuteFn | undefined;
    if (typeof execute !== "function") {
      return {
        ok: false,
        status: 500,
        message: `Executor for ${target.provider} exposes no execute()`,
      };
    }

    const result = await execute.call(executor, {
      model: target.modelId,
      body: req.body,
      stream: req.stream,
      credentials: {},
      signal: req.signal ?? null,
    });

    // The executor returns either a bare Response or { response, ... }.
    const response: Response = result instanceof Response ? result : result.response;

    if (!response.ok) {
      const errorText = await readBoundedErrorBody(response);
      return {
        ok: false,
        status: response.status,
        message: errorText.slice(0, 200) || `HTTP ${response.status}`,
      };
    }

    return { ok: true, response };
  } catch (err) {
    const status = (err as Error & { status?: number }).status ?? 502;
    return {
      ok: false,
      status,
      message: err instanceof Error ? err.message.slice(0, 200) : "Executor failed",
    };
  }
}
