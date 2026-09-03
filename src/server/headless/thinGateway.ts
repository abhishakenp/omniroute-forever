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
import { triggerProviderProvisioning } from "../../sse/services/provisionerHook.ts";
import { getExecutor, hasSpecializedExecutor } from "../../../open-sse/executors/index.ts";
import type { RegistryEntry } from "../../../open-sse/config/providers/shared.ts";
import { estimatePromptTokens, requestedOutputTokens } from "../../lib/db/modelFitness.ts";
import { recordTokenRefusal } from "../../lib/db/targetIterator.ts";

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

  // For direct provider/model requests (e.g. "mistral/mistral-large-latest"),
  // create an iterator scoped to that specific provider+model.
  // For auto/* requests, use the full iterator.
  let specificProvider: string | undefined;
  let specificModel: string | undefined;
  if (!isAuto) {
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

  const iterator = new TargetIterator({
    freeProvidersOnly: isFreeOnly,
    specificProvider,
    specificModel,
    promptTokens,
    outputTokens,
  });

  const registry = getProviderRegistry();
  let attempts = 0;
  const errors: Array<{ model: string; status: number; message: string }> = [];

  while (Date.now() - startTime < TOTAL_BUDGET_MS) {
    const target = iterator.nextTarget();
    if (!target) {
      // All targets exhausted — trigger provisioner for both tried providers
      // AND rate-limited credentialed providers (which were never attempted).
      const providersToProvision = new Set(iterator.triedProviders);
      // Query SQLite for rate-limited credentialed providers
      try {
        const { getDbInstance } = await import("../../lib/db/core.ts");
        const db = getDbInstance();
        const rateLimited = db
          .prepare(
            `SELECT DISTINCT provider FROM provider_connections
             WHERE is_active = 1 AND rate_limited_until IS NOT NULL`
          )
          .all() as Array<{ provider: string }>;
        for (const { provider } of rateLimited) {
          if (!SKIP_PROVIDERS.has(provider)) providersToProvision.add(provider);
        }
      } catch {
        // ignore DB errors
      }

      if (providersToProvision.size > 0) {
        console.log(
          `[thin-gateway] All targets exhausted (${attempts} attempts) — triggering provisioner for: ${[...providersToProvision].join(", ")}`
        );
        for (const provider of providersToProvision) {
          triggerProviderProvisioning(provider);
        }
        // Wait briefly for provisioner to produce a new key
        await new Promise((resolve) => setTimeout(resolve, PROVISIONER_WAIT_MS));
        // Try once more with fresh iterator (new keys may have been inserted).
        // The pin MUST be carried over: this path used to drop
        // specificProvider/specificModel, so a request for `cohere/command-a`
        // whose cohere targets were exhausted came back answered by
        // dahl/MiniMax — a different provider and a different model than the
        // caller asked for, reported as a success.
        const freshIter = new TargetIterator({
          freeProvidersOnly: isFreeOnly,
          specificProvider,
          specificModel,
          promptTokens,
          outputTokens,
        });
        const freshTarget = freshIter.nextTarget();
        if (freshTarget) {
          const result = await tryTarget(freshTarget, req, registry);
          if (result.ok) {
            freshIter.markSucceeded(freshTarget.connectionId);
            return result.response;
          }
        }
      }
      break;
    }

    attempts++;
    console.log(
      `[thin-gateway] Attempt ${attempts}: ${target.modelStr} conn=${target.connectionId.slice(0, 8)}`
    );
    const result = await tryTarget(target, req, registry);
    if (result.ok) {
      console.log(`[thin-gateway] ✓ ${target.modelStr} succeeded`);
      iterator.markSucceeded(target.connectionId);
      return result.response;
    }

    console.log(
      `[thin-gateway] ✗ ${target.modelStr} failed: ${result.status} ${result.message.slice(0, 80)}`
    );
    errors.push({ model: target.modelStr, status: result.status, message: result.message });

    // A prompt-too-large refusal is a fact about this model, not this moment.
    // Record it so the same model is not offered the same size again.
    if (isTokenRefusal(result.status, result.message) && promptTokens > 0) {
      try {
        const { getDbInstance } = await import("../../lib/db/core.ts");
        recordTokenRefusal(getDbInstance(), target.modelStr, promptTokens);
      } catch {
        // Learning is an optimisation, never a failure path.
      }
    }

    iterator.markFailed(target.connectionId, result.status, RATE_LIMIT_COOLDOWN_MS);

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
  return errorResponse(
    503,
    `All providers exhausted after ${attempts} attempts (${elapsed}ms)${sized} | tried: ${summary}${overflowed}${nothingTried}`
  );
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
  if (!providerEntry) {
    return { ok: false, status: 400, message: `Unknown provider: ${target.provider}` };
  }

  const baseUrl = providerEntry.baseUrl || providerEntry.baseUrls?.[0];
  if (!baseUrl) {
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
  if (target.apiKey && providerEntry.authType === "apikey") {
    if (providerEntry.authHeader === "x-api-key") {
      headers["X-API-Key"] = target.apiKey;
    } else {
      headers["Authorization"] = `Bearer ${target.apiKey}`;
    }
  } else if (target.apiKey && !providerEntry.authType && providerEntry.authType !== "none") {
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
