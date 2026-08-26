/**
 * Probe phase — cheap parallel pre-check to find alive providers fast.
 *
 * DESIGN (v2 — parallel, non-blocking):
 *
 * The probe does NOT block the main combo loop. Instead:
 * 1. Start the probe in the background (parallel)
 * 2. Simultaneously start the first real attempt
 * 3. If the first attempt succeeds → cancel probe, return (zero added latency)
 * 4. If the first attempt fails → check probe results:
 *    - Ready → reorder remaining targets (alive first)
 *    - Not ready → wait briefly (3s max), then use whatever we have
 *
 * Cross-request caching (60s TTL): once a probe identifies alive providers,
 * subsequent requests within the cache window reuse those results without
 * re-probing. This amortizes probe cost across bursts of requests.
 *
 * Probe payload: max_tokens=1, messages=[{role:"user",content:"."}],
 * stream=false. Uses the REAL request's other params (reasoning_effort,
 * temperature, etc.) so a 422 on probe = real param incompatibility.
 *
 * Classification:
 *   200       → alive → prioritize in main loop
 *   429       → rateLimited → trigger provisioning, deprioritize
 *   422 param → paramError → skip all keys for this model (deterministic)
 *   422 token → maxTokensError → probe artifact, still try with real params
 *   504/502   → slow → deprioritize
 *   other     → unknown → try after alive
 *
 * Risks handled:
 * - Latency: probe runs in parallel, never blocks first attempt
 * - Quota: one probe per (provider, model) pair, cached 60s
 * - max_tokens=1 422: distinguished from param 422 by error text
 * - Stale results: main loop still handles failures normally
 * - Probe storm: concurrency-limited (20), cached across requests
 */

import type { HandleSingleModel, ComboLogger, ResolvedComboTarget } from "./types.ts";

export type ProbeStatus =
  "alive" | "rateLimited" | "paramError" | "maxTokensError" | "slow" | "unknown";

export interface ProbePhaseResult {
  /** modelStr → probe status */
  results: Map<string, ProbeStatus>;
  /** Providers that returned 429 on probe — trigger provisioning */
  rateLimitedProviders: Set<string>;
  /** Models with deterministic param 422 — skip all keys */
  paramErrorModels: Set<string>;
  /** Models that returned 200 — try first in main loop */
  verifiedAliveModels: Set<string>;
  /** Models that timed out — try last */
  slowModels: Set<string>;
  /** Wall-clock time spent in probe phase */
  elapsedMs: number;
}

export interface ProbePhaseOptions {
  /** Minimum pool size to trigger probing (default 20) */
  minPoolSize?: number;
  /** Max concurrent probes (default 20) */
  concurrency?: number;
  /** Per-probe timeout (default 5000ms) */
  timeoutMs?: number;
  /** Cache TTL in ms (default 60000) */
  cacheTtlMs?: number;
}

// ─── Cross-request probe cache ───────────────────────────────────────────────
// Keyed by combo name. Once a probe completes, results are cached so subsequent
// requests within the TTL window skip probing entirely.

interface CachedProbe {
  result: ProbePhaseResult;
  timestamp: number;
  comboName: string;
}

const probeCache = new Map<string, CachedProbe>();
const DEFAULT_CACHE_TTL_MS = 60_000;

// ─── Inflight probe deduplication ───────────────────────────────────────────
// When multiple concurrent requests arrive and the cache is expired, they all
// trigger fresh probes simultaneously (thundering herd). This map tracks
// in-flight probes so subsequent requests wait for the first probe to complete
// instead of starting duplicate probes.
const inflightProbes = new Map<string, Promise<ProbePhaseResult | null>>();

/**
 * Get cached probe results if still fresh.
 */
export function getCachedProbe(
  comboName: string,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): ProbePhaseResult | null {
  const cached = probeCache.get(comboName);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > ttlMs) {
    probeCache.delete(comboName);
    return null;
  }
  return cached.result;
}

/**
 * Invalidate cached probe for a combo (e.g. after all providers fail).
 */
export function invalidateProbeCache(comboName: string): void {
  probeCache.delete(comboName);
}

/**
 * Start the probe phase in the background. Returns a promise that resolves
 * when probing is complete. Does NOT block — caller should start the first
 * real attempt in parallel and only await probe results if the first attempt
 * fails.
 *
 * Returns null if pool is too small or cache is fresh.
 */
export function startProbePhase(
  comboName: string,
  orderedTargets: ResolvedComboTarget[],
  handleSingleModel: HandleSingleModel,
  body: Record<string, unknown>,
  log: ComboLogger,
  signal?: AbortSignal,
  options?: ProbePhaseOptions
): Promise<ProbePhaseResult | null> | null {
  const minPoolSize = options?.minPoolSize ?? 20;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  if (orderedTargets.length < minPoolSize) return null;
  if (signal?.aborted) return null;

  // Check cache first — if we have fresh results, return them immediately
  const cached = getCachedProbe(comboName, cacheTtlMs);
  if (cached) {
    log.info(
      "COMBO-PROBE",
      `Using cached probe results for "${comboName}" (${cached.verifiedAliveModels.size} alive, ${cached.elapsedMs}ms original)`
    );
    return Promise.resolve(cached);
  }

  // Check if a probe is already in-flight for this combo — if so, wait for it
  // instead of starting a duplicate probe (thundering herd prevention).
  const inflight = inflightProbes.get(comboName);
  if (inflight) {
    log.info(
      "COMBO-PROBE",
      `Probe already in-flight for "${comboName}" — waiting for existing probe`
    );
    return inflight;
  }

  // Start probe in background and track it as in-flight
  const probePromise = runProbePhase(
    comboName,
    orderedTargets,
    handleSingleModel,
    body,
    log,
    signal,
    options
  );
  inflightProbes.set(comboName, probePromise);
  // Clean up the in-flight entry when the probe completes (or fails)
  probePromise.finally(() => inflightProbes.delete(comboName));
  return probePromise;
}

/**
 * Run the probe phase. Returns null if pool is too small.
 */
async function runProbePhase(
  comboName: string,
  orderedTargets: ResolvedComboTarget[],
  handleSingleModel: HandleSingleModel,
  body: Record<string, unknown>,
  log: ComboLogger,
  signal?: AbortSignal,
  options?: ProbePhaseOptions
): Promise<ProbePhaseResult | null> {
  const concurrency = options?.concurrency ?? 20;
  const timeoutMs = options?.timeoutMs ?? 15_000; // 15s — free-tier APIs are slow (measured: 8-14s for working models)
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Deduplicate by (provider, modelStr) — one probe per unique combo
  const seen = new Set<string>();
  const uniqueTargets: ResolvedComboTarget[] = [];
  for (const t of orderedTargets) {
    const key = `${t.provider}::${t.modelStr}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueTargets.push(t);
    }
  }
  if (uniqueTargets.length < 3) return null; // not enough diversity to justify probing

  log.info(
    "COMBO-PROBE",
    `Probing ${uniqueTargets.length} unique (provider, model) pairs from ${orderedTargets.length} targets (concurrency=${concurrency}, timeout=${timeoutMs}ms)`
  );

  const probeBody: Record<string, unknown> = {
    ...body,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
    stream: false,
  };

  const results = new Map<string, ProbeStatus>();
  const rateLimitedProviders = new Set<string>();
  const paramErrorModels = new Set<string>();
  const verifiedAliveModels = new Set<string>();
  const slowModels = new Set<string>();

  const startTime = Date.now();

  // Concurrency-limited parallel probes
  let index = 0;
  const probeOne = async (): Promise<void> => {
    while (index < uniqueTargets.length) {
      if (signal?.aborted) return;
      const myIndex = index++;
      const target = uniqueTargets[myIndex];
      const modelStr = target.modelStr;

      try {
        const result = await probeSingleTarget(
          handleSingleModel,
          probeBody,
          modelStr,
          target,
          timeoutMs
        );

        const status = classifyProbeResult(result.status, result.errorText);
        results.set(modelStr, status);

        switch (status) {
          case "alive":
            verifiedAliveModels.add(modelStr);
            break;
          case "rateLimited":
            rateLimitedProviders.add(target.provider);
            break;
          case "paramError":
            paramErrorModels.add(modelStr);
            break;
          case "slow":
            slowModels.add(modelStr);
            break;
        }
      } catch {
        // Probe failed entirely — classify as unknown
        results.set(modelStr, "unknown");
      }
    }
  };

  // Launch `concurrency` workers
  const workers = Array.from({ length: Math.min(concurrency, uniqueTargets.length) }, () =>
    probeOne()
  );
  await Promise.all(workers);

  const elapsedMs = Date.now() - startTime;

  log.info(
    "COMBO-PROBE",
    `Probe complete in ${elapsedMs}ms: ${verifiedAliveModels.size} alive, ${rateLimitedProviders.size} rate-limited, ${paramErrorModels.size} param-errors, ${slowModels.size} slow, ${results.size - verifiedAliveModels.size - rateLimitedProviders.size - paramErrorModels.size - slowModels.size} unknown`
  );

  const result: ProbePhaseResult = {
    results,
    rateLimitedProviders,
    paramErrorModels,
    verifiedAliveModels,
    slowModels,
    elapsedMs,
  };

  // Cache for subsequent requests
  probeCache.set(comboName, { result, timestamp: Date.now(), comboName });

  return result;
}

/**
 * Send a single probe request with a tight timeout.
 * Uses AbortController to cancel the request if it exceeds the timeout.
 */
async function probeSingleTarget(
  handleSingleModel: HandleSingleModel,
  probeBody: Record<string, unknown>,
  modelStr: string,
  target: ResolvedComboTarget,
  timeoutMs: number
): Promise<{ status: number; errorText?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const probeTarget = {
      ...target,
      modelAbortSignal: controller.signal,
      // Probes are low-priority — don't count them in metrics
      trafficType: "shadow" as const,
    };

    const response = await Promise.race([
      handleSingleModel(probeBody, modelStr, probeTarget),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error("probe_timeout")), timeoutMs + 1000)
      ),
    ]);

    let errorText: string | undefined;
    if (!response.ok) {
      try {
        errorText = await response.text();
      } catch {
        // Body read failed — status is still useful
      }
    }

    return { status: response.status, errorText };
  } catch (err) {
    // Timeout or network error — return a synthetic 504
    return { status: 504, errorText: err instanceof Error ? err.message : "probe_failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Classify a probe response into a status category.
 *
 * Distinguishes param 422 (e.g. "reasoning_effort not supported") from
 * max_tokens 422 (e.g. "max_tokens must be at least 16") — the former is
 * deterministic for the real request, the latter is a probe artifact.
 */
function classifyProbeResult(status: number, errorText?: string): ProbeStatus {
  if (status >= 200 && status < 300) return "alive";
  if (status === 429) return "rateLimited";
  if (status === 504 || status === 502 || status === 503) return "slow";

  if (status === 422) {
    const text = (errorText || "").toLowerCase();
    // max_tokens=1 might itself be rejected — that's a probe artifact, not a real param error
    if (
      text.includes("max_tokens") ||
      text.includes("max output") ||
      text.includes("minimum") ||
      text.includes("at least 1 token") ||
      text.includes("must be greater")
    ) {
      return "maxTokensError";
    }
    // Other 422 = param incompatibility (reasoning_effort, temperature, etc.)
    return "paramError";
  }

  // 400 param validation errors — deterministic for the real request too
  if (status === 400) {
    const text = (errorText || "").toLowerCase();
    if (
      (text.includes("reasoning_effort") &&
        (text.includes("not supported") || text.includes("not enabled"))) ||
      text.includes("unsupported parameter") ||
      (text.includes("parameter") &&
        (text.includes("not supported") || text.includes("not enabled"))) ||
      (text.includes("max") && text.includes("tokens") && text.includes("must be"))
    ) {
      return "paramError";
    }
    // max_tokens=1 might 400 on some providers — probe artifact
    if (
      text.includes("max_tokens") ||
      text.includes("max output") ||
      text.includes("minimum") ||
      text.includes("at least 1 token")
    ) {
      return "maxTokensError";
    }
  }

  // 400 (other), 401, 403, 404, 500 — unknown, might work or might not
  return "unknown";
}

/**
 * Reorder targets based on probe results.
 *
 * Order: alive → unknown → maxTokensError → rateLimited → slow
 * paramError models are excluded (they're in failedModelSet).
 */
export function reorderByProbeResults(
  targets: ResolvedComboTarget[],
  probe: ProbePhaseResult
): ResolvedComboTarget[] {
  const alive: ResolvedComboTarget[] = [];
  const unknown: ResolvedComboTarget[] = [];
  const maxTokensError: ResolvedComboTarget[] = [];
  const rateLimited: ResolvedComboTarget[] = [];
  const slow: ResolvedComboTarget[] = [];

  for (const t of targets) {
    if (probe.paramErrorModels.has(t.modelStr)) continue; // skip — deterministic failure

    const status = probe.results.get(t.modelStr);
    switch (status) {
      case "alive":
        alive.push(t);
        break;
      case "rateLimited":
        rateLimited.push(t);
        break;
      case "slow":
        slow.push(t);
        break;
      case "maxTokensError":
        maxTokensError.push(t);
        break;
      default:
        // unknown or not probed
        unknown.push(t);
        break;
    }
  }

  return [...alive, ...unknown, ...maxTokensError, ...rateLimited, ...slow];
}
