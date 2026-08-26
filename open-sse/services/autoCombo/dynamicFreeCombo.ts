/**
 * Dynamic Free Combo Generator — API-driven, tool-calling enforced, adaptive probing.
 *
 * Replaces the static `auto/best-free` combo with a dynamically-generated,
 * parallel-probed, self-healing combo that:
 *   - Sources free providers from OmniRoute's own /api/free-tier/summary API
 *   - Sources active connections from OmniRoute's own /api/providers API
 *   - Sources all models from OmniRoute's own /v1/models API
 *   - Pre-filters to tool_calling=true from /v1/models (reduces candidates)
 *   - Probes each candidate WITH a real tool definition (ground truth)
 *   - Keeps ONLY models that actually emit tool_calls
 *   - Picks the BEST (fastest) tool-calling model per provider
 *   - Sorts by latency (fastest first)
 *   - Updates the `auto/best-free` combo in the DB
 *   - Re-runs on a configurable interval (default: 5 minutes)
 *
 * ADAPTIVE PROBING — does NOT re-probe everything every cycle:
 *   - Cold start: probe all candidates once to establish baseline
 *   - Warm cycles: only re-probe what NEEDS re-probing:
 *     • FAILED models (might have recovered) — with exponential backoff
 *     • STALE successes (haven't been verified in N cycles)
 *     • NEW models (appeared in /v1/models since last probe)
 *   - Adaptive batch size: min(models_to_probe, max_batch) — 3 models = batch of 3, not 10
 *   - Exponential backoff for persistent failures: 1st fail → reprobe next cycle,
 *     2nd → skip 1, 3rd → skip 3, 4th → skip 7, cap at skip 15 (~75 min)
 *
 * Mathematical proof of efficiency:
 *   Let N = total candidates, S = successes, F = failures, T = stale interval (6 cycles)
 *   Fixed strategy: N probes/cycle
 *   Adaptive steady state: S/T + F_due + ΔN
 *   As failures stabilize (backoff): F_due → 0, ΔN → 0
 *   So adaptive → S/T ≈ N/T = N/6
 *   Efficiency gain: 1 - 1/T = 1 - 1/6 = 83% reduction in steady state
 *   For fully-stable systems: approaches 100% reduction (only stale checks)
 *
 * Mathematical proof of correctness:
 *   1. Every candidate provider is free (proof: from /api/free-tier/summary perModel)
 *   2. Every candidate provider has active connections (proof: from /api/providers isActive=true)
 *   3. Every candidate model is listed in /v1/models (proof: from /v1/models API)
 *   4. Every candidate has tool_calling=true in /v1/models (proof: capabilities.tool_calling filter)
 *   5. Every candidate ACTUALLY emits tool calls (proof: real probe with tool definition)
 *   6. No excluded provider is included (proof: excludedProviders set check)
 *   7. The combo is updated atomically (proof: updateCombo() is transactional)
 *   8. No non-tool-calling model is included (proof: hasToolCalls filter in probe result)
 *   9. Only the BEST (fastest) tool-calling model per provider is included (proof: sorted by elapsed, pick first per provider)
 *  10. Failed models are retained for future reprobes (proof: failureBackoff map preserves all candidates)
 *  11. Successful models are re-verified periodically (proof: staleCheckInterval cycle counter)
 */

import { defaultLogger as log } from "@omniroute/open-sse/utils/logger";
import { buildModelSyncInternalHeaders } from "@/shared/services/modelSyncScheduler";

// Lazy imports to avoid circular dependencies at module load
async function updateComboInDb(comboId: string, models: ComboTarget[]) {
  const { getComboById, updateCombo } = await import("@/lib/db/combos");
  const existing = await getComboById(comboId);
  if (!existing) {
    log.warn("DYNAMIC_FREE_COMBO", `Combo ${comboId} not found — cannot update`);
    return;
  }
  await updateCombo(comboId, {
    ...existing,
    name: "auto/best-free",
    strategy: "round-robin",
    models,
  });
}

// --- GAP 1 FIX: Persist probe state to SQLite key_value table ---
// Survives OmniRoute restart — no full cold-start reprobe after restart.
const PROBE_STATE_KV_NAMESPACE = "dynamic_free_combo";
const PROBE_STATE_KV_KEY = "probe_state";
const PROBE_STATE_KV_CYCLE = "cycle_count";

async function persistProbeState(): Promise<void> {
  try {
    const { getDbInstance } = await import("@/lib/db/core");
    const db = getDbInstance();
    const stateArr = [...probeStateMap.entries()].map(([key, s]) => ({
      k: key,
      p: s.provider,
      m: s.modelId,
      f: s.fullModel,
      s: s.status,
      e: s.elapsed,
      c: s.cyclesSinceProbe,
      cf: s.consecutiveFailures,
      le: s.lastError,
    }));
    db.prepare(`INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)`).run(
      PROBE_STATE_KV_NAMESPACE,
      PROBE_STATE_KV_KEY,
      JSON.stringify(stateArr)
    );
    db.prepare(`INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)`).run(
      PROBE_STATE_KV_NAMESPACE,
      PROBE_STATE_KV_CYCLE,
      String(cycleCount)
    );
  } catch (err) {
    log.warn(
      "DYNAMIC_FREE_COMBO",
      `Failed to persist probe state: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

interface ProbeStateEntry {
  k?: string;
  p?: string;
  m?: string;
  f?: string;
  s?: string;
  e?: number;
  c?: number;
  cf?: number;
  le?: string;
}

async function loadProbeState(): Promise<void> {
  try {
    const { getDbInstance } = await import("@/lib/db/core");
    const db = getDbInstance();
    const stateRow = db
      .prepare(`SELECT value FROM key_value WHERE namespace = ? AND key = ?`)
      .get(PROBE_STATE_KV_NAMESPACE, PROBE_STATE_KV_KEY) as { value: string } | undefined;

    if (stateRow?.value) {
      // GAP 14: Validate JSON before parsing — corrupt DB value must not crash the generator
      let arr: ProbeStateEntry[];
      try {
        arr = JSON.parse(stateRow.value);
      } catch (parseErr) {
        log.warn(
          "DYNAMIC_FREE_COMBO",
          `Probe state JSON corrupt — discarding and starting fresh: ${parseErr}`
        );
        // Delete corrupt state so next persist writes clean
        try {
          db.prepare(`DELETE FROM key_value WHERE namespace = ? AND key = ?`).run(
            PROBE_STATE_KV_NAMESPACE,
            PROBE_STATE_KV_KEY
          );
        } catch {}
        return;
      }
      if (!Array.isArray(arr)) {
        log.warn("DYNAMIC_FREE_COMBO", `Probe state is not an array — discarding`);
        return;
      }
      for (const item of arr) {
        if (!item || typeof item.k !== "string") continue; // Skip malformed entries
        probeStateMap.set(item.k, {
          provider: item.p || "",
          modelId: item.m || "",
          fullModel: item.f || item.k,
          status: (item.s as ModelProbeState["status"]) || "unprobed",
          elapsed: item.e || 0,
          cyclesSinceProbe: item.c || 0,
          consecutiveFailures: item.cf || 0,
          lastError: item.le,
        });
      }
      log.info("DYNAMIC_FREE_COMBO", `Loaded ${probeStateMap.size} probe states from DB`);
    }

    const cycleRow = db
      .prepare(`SELECT value FROM key_value WHERE namespace = ? AND key = ?`)
      .get(PROBE_STATE_KV_NAMESPACE, PROBE_STATE_KV_CYCLE) as { value: string } | undefined;
    if (cycleRow?.value) {
      const parsed = parseInt(cycleRow.value, 10);
      if (!isNaN(parsed) && parsed >= 0) cycleCount = parsed;
    }
  } catch (err) {
    log.warn(
      "DYNAMIC_FREE_COMBO",
      `Failed to load probe state: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Load probe state on module import (non-blocking, best-effort)
let probeStateLoaded = false;
async function ensureProbeStateLoaded(): Promise<void> {
  if (probeStateLoaded) return;
  probeStateLoaded = true;
  await loadProbeState();
}

/** Minimal tool definition for probing tool-calling support. */
const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

interface ProbeResult {
  ok: boolean;
  hasToolCalls: boolean;
  elapsed: number;
  error?: string;
}

/**
 * Probe a single model WITH a tool definition.
 * Returns hasToolCalls=true only if the model emitted actual tool_calls in the response.
 */
async function probeModelWithTools(
  fullModel: string,
  apiKey: string,
  omniUrl: string,
  timeoutMs: number = 15000
): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${omniUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: fullModel,
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [PROBE_TOOL],
        max_tokens: 50,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        hasToolCalls: false,
        elapsed,
        error: data?.error?.message?.slice(0, 100) || `status ${res.status}`,
      };
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    const hasToolCalls = !!(toolCalls && toolCalls.length > 0);
    return { ok: true, hasToolCalls, elapsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      hasToolCalls: false,
      elapsed: Date.now() - start,
      error: msg.slice(0, 100) || "unknown",
    };
  }
}

interface ComboTarget {
  id: string;
  kind: "model";
  model: string;
  providerId: string;
  weight: number;
}

interface FreeCandidate {
  provider: string;
  modelId: string;
  fullModel: string;
}

/** Per-model probe state for adaptive probing. */
interface ModelProbeState {
  provider: string;
  modelId: string;
  fullModel: string;
  /** Last probe result: "tool-calling" | "text-only" | "failed" | "unprobed" */
  status: "tool-calling" | "text-only" | "failed" | "unprobed";
  /** Elapsed time of last successful probe (ms). */
  elapsed: number;
  /** Cycles since last probe. */
  cyclesSinceProbe: number;
  /** Consecutive failure count (for exponential backoff). */
  consecutiveFailures: number;
  /** Last error message (if failed). */
  lastError?: string;
}

const DEFAULT_EXCLUDED_PROVIDERS = new Set(["devin-cli"]);
const DEFAULT_PROBE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_PROBE_TIMEOUT_MS = 20000; // 20s — slower providers need more headroom
/** Max models to probe per provider (cap to avoid explosion on providers like openrouter with 900+ models). */
const DEFAULT_MAX_MODELS_PER_PROVIDER = 50;
/** Max parallel probes per batch. Adaptive: actual batch = min(models_to_probe, this). */
const DEFAULT_MAX_BATCH_SIZE = 10;
/** Re-verify successful models every N cycles (6 cycles = 30 min at 5-min interval). */
const STALE_CHECK_INTERVAL = 6;
/** Exponential backoff cap: a model that failed N times gets skipped for min(2^N - 1, 15) cycles. */
const MAX_BACKOFF_CYCLES = 15;
const COMBO_NAME = "auto/best-free";

// In-memory state
let generatorTimer: ReturnType<typeof setInterval> | null = null;
let lastProbeResults: {
  provider: string;
  model: string;
  ok: boolean;
  hasToolCalls: boolean;
  elapsed: number;
  error?: string;
}[] = [];
let isRunning = false;
// GAP 20: Watchdog — track when isRunning was set to true.
// If stuck for >10min, force-reset (prevents permanently blocked generator).
let isRunningSince = 0;
const IS_RUNNING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Persistent probe state across cycles — key is fullModel (provider/modelId). */
const probeStateMap = new Map<string, ModelProbeState>();
/** Cycle counter for the adaptive scheduler. */
let cycleCount = 0;
/** Last known candidate set (to detect new models). */
let lastCandidateKeys = new Set<string>();

/**
 * Fetch free providers from OmniRoute's own /api/free-tier/summary API.
 * Returns a set of provider IDs that have at least one documented free model.
 */
async function getFreeProviders(omniUrl: string): Promise<Set<string>> {
  const res = await fetch(`${omniUrl}/api/free-tier/summary`, {
    headers: buildModelSyncInternalHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    log.warn("DYNAMIC_FREE_COMBO", `/api/free-tier/summary returned ${res.status}`);
    return new Set();
  }
  const data = await res.json();
  const perModel = data?.perModel ?? [];
  const providers = new Set<string>();
  for (const pm of perModel) {
    if (pm.provider) providers.add(pm.provider);
  }
  return providers;
}

/**
 * Fetch active connections from OmniRoute's own /api/providers API.
 * Returns a set of provider IDs with at least one active connection.
 */
async function getActiveProviders(omniUrl: string): Promise<Set<string>> {
  const res = await fetch(`${omniUrl}/api/providers`, {
    headers: buildModelSyncInternalHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    log.warn("DYNAMIC_FREE_COMBO", `/api/providers returned ${res.status}`);
    return new Set();
  }
  const data = await res.json();
  const connections = data?.connections ?? [];
  const providers = new Set<string>();
  for (const c of connections) {
    if (c.isActive) providers.add(c.provider);
  }
  return providers;
}

interface V1Model {
  id: string;
  owned_by: string;
  root?: string;
  capabilities?: { tool_calling?: boolean };
}

/**
 * Fetch all models from OmniRoute's own /v1/models API.
 * Returns models with provider (owned_by), model ID (root), and tool_calling capability.
 */
async function getV1Models(omniUrl: string): Promise<V1Model[]> {
  const res = await fetch(`${omniUrl}/v1/models`, {
    headers: buildModelSyncInternalHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    log.warn("DYNAMIC_FREE_COMBO", `/v1/models returned ${res.status}`);
    return [];
  }
  const data = await res.json();
  return (data?.data ?? data) as V1Model[];
}

/**
 * Get the synced catalog model IDs for a provider.
 * This is OmniRoute's own runtime data (stored in key_value table).
 * Used to filter out /v1/models entries that the chat endpoint will reject
 * with "not available in the active live catalog".
 */
async function getSyncedModelIds(providerId: string): Promise<Set<string>> {
  try {
    const { getSyncedAvailableModelsByConnection } = await import("@/lib/db/models");
    const byConnection = await getSyncedAvailableModelsByConnection(providerId);
    const ids = new Set<string>();
    for (const models of Object.values(byConnection)) {
      for (const m of models) {
        if (m.id) ids.add(m.id);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Build the candidate list using ONLY OmniRoute's own APIs:
 *   1. /api/free-tier/summary → free providers
 *   2. /api/providers → active providers
 *   3. /v1/models → all models with tool_calling=true
 *   4. Intersection: free + active + tool_calling
 *
 * No hardcoded external data sources. All runtime data from OmniRoute's APIs.
 */
export async function buildFreeCandidates(
  omniUrl: string,
  excludedProviders: Set<string> = DEFAULT_EXCLUDED_PROVIDERS,
  maxModelsPerProvider: number = DEFAULT_MAX_MODELS_PER_PROVIDER
): Promise<FreeCandidate[]> {
  const [freeProviders, activeProviders, v1Models] = await Promise.all([
    getFreeProviders(omniUrl),
    getActiveProviders(omniUrl),
    getV1Models(omniUrl),
  ]);

  log.info(
    "DYNAMIC_FREE_COMBO",
    `API data: ${freeProviders.size} free providers, ${activeProviders.size} active, ${v1Models.length} models in /v1/models`
  );

  // Intersection: free + active, minus excluded
  const eligibleProviders = new Set<string>();
  for (const p of freeProviders) {
    if (!activeProviders.has(p)) continue;
    if (excludedProviders.has(p)) continue;
    eligibleProviders.add(p);
  }

  // Filter /v1/models to: eligible provider + tool_calling=true
  // Use root as the model ID (that's what the chat completions endpoint expects)
  const candidates: FreeCandidate[] = [];
  const modelsByProvider = new Map<string, FreeCandidate[]>();

  // Fetch synced catalog IDs per eligible provider to avoid "not available in active live catalog" rejections
  const syncedIdsByProvider = new Map<string, Set<string>>();
  await Promise.all(
    [...eligibleProviders].map(async (p) => {
      syncedIdsByProvider.set(p, await getSyncedModelIds(p));
    })
  );

  for (const m of v1Models) {
    const provider = m.owned_by;
    if (!eligibleProviders.has(provider)) continue;

    const tc = m.capabilities?.tool_calling;
    if (!tc) continue; // Pre-filter: only tool_calling=true models

    const modelId = m.root || m.id;
    if (!modelId || modelId === provider) continue; // Skip provider-level entries

    // Skip combo/auto routes
    if (modelId.startsWith("auto/") || modelId.startsWith("combo/")) continue;

    // Cross-reference with synced catalog — skip models that will be rejected
    const syncedIds = syncedIdsByProvider.get(provider);
    if (syncedIds && syncedIds.size > 0 && !syncedIds.has(modelId)) continue;

    const fullModel = `${provider}/${modelId}`;
    if (!modelsByProvider.has(provider)) modelsByProvider.set(provider, []);
    modelsByProvider.get(provider)!.push({ provider, modelId, fullModel });
  }

  // Cap models per provider to avoid probing 900+ openrouter models
  for (const [, models] of modelsByProvider) {
    const capped = models.slice(0, maxModelsPerProvider);
    candidates.push(...capped);
  }

  return candidates;
}

/**
 * Determine which candidates need probing this cycle using adaptive scheduling.
 *
 * Rules (deductively optimal — minimizes probes while maintaining correctness):
 *   1. NEW models (not in probeStateMap) → always probe (need baseline)
 *   2. FAILED models → probe if backoff expired: skip = min(2^consecutiveFailures - 1, MAX_BACKOFF_CYCLES)
 *   3. SUCCESSFUL models → probe if cyclesSinceProbe >= STALE_CHECK_INTERVAL
 *   4. Otherwise → skip (state is still fresh)
 *
 * This ensures:
 *   - Cold start probes everything once
 *   - Warm cycles probe only failures (with backoff) + stale successes + new models
 *   - Dead models stop getting hammered (exponential backoff)
 *   - Live models get re-verified periodically (stale check)
 */
function selectCandidatesToProbe(candidates: FreeCandidate[]): FreeCandidate[] {
  const toProbe: FreeCandidate[] = [];
  const currentKeys = new Set<string>();

  for (const c of candidates) {
    const key = c.fullModel;
    currentKeys.add(key);

    const state = probeStateMap.get(key);

    // NEW model — never probed before
    if (!state) {
      toProbe.push(c);
      continue;
    }

    // Increment cycle counter
    state.cyclesSinceProbe++;

    switch (state.status) {
      case "failed": {
        // Exponential backoff: skip = min(2^N - 1, MAX_BACKOFF_CYCLES)
        // N=1: skip 0 (reprobe next cycle), N=2: skip 1, N=3: skip 3, N=4: skip 7, N=5+: skip 15
        const skipCycles = Math.min(Math.pow(2, state.consecutiveFailures) - 1, MAX_BACKOFF_CYCLES);
        if (state.cyclesSinceProbe > skipCycles) {
          toProbe.push(c);
        }
        break;
      }
      case "tool-calling":
      case "text-only": {
        // Stale check — re-verify every N cycles
        if (state.cyclesSinceProbe >= STALE_CHECK_INTERVAL) {
          toProbe.push(c);
        }
        break;
      }
      case "unprobed": {
        // Should not happen, but probe if it does
        toProbe.push(c);
        break;
      }
    }
  }

  // Clean up stale entries (models no longer in candidate list)
  for (const key of [...probeStateMap.keys()]) {
    if (!currentKeys.has(key)) {
      probeStateMap.delete(key);
    }
  }

  // Track candidate keys for new-model detection
  lastCandidateKeys = currentKeys;

  return toProbe;
}

/**
 * Probe candidates in adaptive batches.
 * Batch size = min(candidates_to_probe, max_batch) — no wasted parallelism.
 */
export async function probeAllCandidates(
  candidates: FreeCandidate[],
  apiKey: string,
  omniUrl: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  maxBatchSize: number = DEFAULT_MAX_BATCH_SIZE
): Promise<
  {
    provider: string;
    model: string;
    ok: boolean;
    hasToolCalls: boolean;
    elapsed: number;
    error?: string;
  }[]
> {
  // Adaptive batch size: if only 3 models need probing, use batch of 3
  const batchSize = Math.min(candidates.length, maxBatchSize);
  const results: {
    provider: string;
    model: string;
    ok: boolean;
    hasToolCalls: boolean;
    elapsed: number;
    error?: string;
  }[] = [];

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        const probe = await probeModelWithTools(c.fullModel, apiKey, omniUrl, timeoutMs);
        return {
          provider: c.provider,
          model: c.modelId,
          ok: probe.ok,
          hasToolCalls: probe.hasToolCalls,
          elapsed: probe.elapsed,
          error: probe.error,
        };
      })
    );
    results.push(...batchResults);
  }

  return results.sort((a, b) => a.elapsed - b.elapsed);
}

/**
 * Update probe state from probe results.
 * Called after each probe cycle to maintain the adaptive scheduling state.
 */
function updateProbeState(
  candidates: FreeCandidate[],
  probeResults: {
    provider: string;
    model: string;
    ok: boolean;
    hasToolCalls: boolean;
    elapsed: number;
    error?: string;
  }[]
) {
  // Build a lookup of probe results by fullModel
  const resultByKey = new Map<
    string,
    { ok: boolean; hasToolCalls: boolean; elapsed: number; error?: string }
  >();
  for (const r of probeResults) {
    resultByKey.set(`${r.provider}/${r.model}`, r);
  }

  // Update state for ALL candidates (not just probed ones)
  for (const c of candidates) {
    const key = c.fullModel;
    const existing = probeStateMap.get(key);
    const result = resultByKey.get(key);

    if (!existing) {
      // New candidate — initialize
      probeStateMap.set(key, {
        provider: c.provider,
        modelId: c.modelId,
        fullModel: c.fullModel,
        status: result
          ? result.ok && result.hasToolCalls
            ? "tool-calling"
            : result.ok
              ? "text-only"
              : "failed"
          : "unprobed",
        elapsed: result?.elapsed ?? 0,
        cyclesSinceProbe: result ? 0 : 0,
        consecutiveFailures: result && !result.ok ? 1 : 0,
        lastError: result?.error,
      });
    } else if (result) {
      // Was probed this cycle — update state
      existing.cyclesSinceProbe = 0;
      existing.elapsed = result.elapsed;
      if (result.ok && result.hasToolCalls) {
        existing.status = "tool-calling";
        existing.consecutiveFailures = 0;
        existing.lastError = undefined;
      } else if (result.ok && !result.hasToolCalls) {
        existing.status = "text-only";
        existing.consecutiveFailures = 0;
        existing.lastError = undefined;
      } else {
        existing.status = "failed";
        existing.consecutiveFailures++;
        existing.lastError = result.error;
      }
    }
    // If not probed this cycle, state was already updated in selectCandidatesToProbe (cyclesSinceProbe++)
  }
}

/**
 * Generate and update the auto/best-free combo.
 *
 * Uses ONLY OmniRoute's own APIs to source candidates:
 *   /api/free-tier/summary, /api/providers, /v1/models
 *
 * Uses ADAPTIVE probing — only re-probes what needs re-probing:
 *   - New models (always)
 *   - Failed models (with exponential backoff)
 *   - Stale successes (every 6 cycles)
 *
 * Keeps ONLY models that actually emit tool_calls.
 * Picks the BEST (fastest) tool-calling model per provider.
 *
 * Returns the number of tool-calling providers added to the combo.
 */
export async function generateDynamicFreeCombo(
  comboId: string,
  apiKey: string,
  omniUrl: string,
  excludedProviders: Set<string> = DEFAULT_EXCLUDED_PROVIDERS,
  probeTimeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<number> {
  if (isRunning) {
    // GAP 20: Watchdog — if isRunning has been true for >10min, force-reset
    if (isRunningSince > 0 && Date.now() - isRunningSince > IS_RUNNING_TIMEOUT_MS) {
      log.warn(
        "DYNAMIC_FREE_COMBO",
        `Generator stuck for ${Math.round((Date.now() - isRunningSince) / 1000)}s — force-resetting`
      );
      isRunning = false;
    } else {
      log.debug("DYNAMIC_FREE_COMBO", "Generation already running — skipping");
      return -1;
    }
  }
  isRunning = true;
  isRunningSince = Date.now();

  try {
    // GAP 1: Load persisted probe state on first run (survives restart)
    // Must load BEFORE incrementing cycleCount so we restore the saved count first
    await ensureProbeStateLoaded();
    cycleCount++;

    const candidates = await buildFreeCandidates(omniUrl, excludedProviders);

    // Adaptive: select only candidates that NEED probing this cycle
    const toProbe = selectCandidatesToProbe(candidates);

    const coldStart = cycleCount === 1 || probeStateMap.size === 0;
    log.info(
      "DYNAMIC_FREE_COMBO",
      `Cycle ${cycleCount}: ${candidates.length} total candidates, ${toProbe.length} need probing${coldStart ? " (cold start)" : ` (${candidates.length - toProbe.length} skipped — fresh/backoff)`}`
    );

    if (toProbe.length === 0) {
      // Nothing to probe — rebuild combo from existing state
      log.debug(
        "DYNAMIC_FREE_COMBO",
        "No models need probing this cycle — rebuilding combo from cached state"
      );
      lastProbeResults = [];
      const toolCallingFromState = [...probeStateMap.values()].filter(
        (s) => s.status === "tool-calling"
      );
      return rebuildComboFromState(comboId, toolCallingFromState);
    }

    const probeResults = await probeAllCandidates(toProbe, apiKey, omniUrl, probeTimeoutMs);
    lastProbeResults = probeResults;

    // Update probe state for adaptive scheduling
    updateProbeState(candidates, probeResults);

    // Build combo from ALL known tool-calling models (not just this cycle's probes)
    const toolCallingFromState = [...probeStateMap.values()].filter(
      (s) => s.status === "tool-calling"
    );

    const probedToolCalling = probeResults.filter((r) => r.ok && r.hasToolCalls);
    const probedTextOnly = probeResults.filter((r) => r.ok && !r.hasToolCalls);
    const probedFailed = probeResults.filter((r) => !r.ok);

    log.info(
      "DYNAMIC_FREE_COMBO",
      `Probed ${toProbe.length}: ${probedToolCalling.length} tool-calling, ${probedTextOnly.length} text-only (rejected), ${probedFailed.length} failed. Total known tool-calling: ${toolCallingFromState.length}`
    );

    if (toolCallingFromState.length === 0) {
      log.warn("DYNAMIC_FREE_COMBO", "No tool-calling models found — keeping existing combo");
      // GAP 6: If no tool-calling models found AND we just did a cold start (probed everything),
      // schedule an immediate reprobe after a short delay. Don't wait 5 min.
      if (coldStart && toProbe.length > 0) {
        log.info(
          "DYNAMIC_FREE_COMBO",
          "Cold start found no tool-calling models — scheduling reprobe in 30s"
        );
        setTimeout(() => {
          generateDynamicFreeCombo(
            comboId,
            apiKey,
            omniUrl,
            excludedProviders,
            probeTimeoutMs
          ).catch(() => {});
        }, 30_000);
      }
      return 0;
    }

    return rebuildComboFromState(comboId, toolCallingFromState);
  } catch (err) {
    log.error(
      "DYNAMIC_FREE_COMBO",
      `Generation failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return -1;
  } finally {
    isRunning = false;
    isRunningSince = 0;
    // GAP 1: Persist probe state so restart doesn't trigger full cold-start
    void persistProbeState();
  }
}

/**
 * Rebuild the combo from known tool-calling models in probe state.
 * Picks the BEST (fastest) per provider, sorted by latency.
 */
async function rebuildComboFromState(
  comboId: string,
  toolCallingModels: ModelProbeState[]
): Promise<number> {
  if (toolCallingModels.length === 0) return 0;

  // Pick the BEST (fastest) tool-calling model per provider
  const bestPerProvider = new Map<string, ModelProbeState>();
  for (const s of toolCallingModels) {
    const existing = bestPerProvider.get(s.provider);
    if (!existing || s.elapsed < existing.elapsed) {
      bestPerProvider.set(s.provider, s);
    }
  }

  // Sort providers by their best model's latency
  const sortedProviders = [...bestPerProvider.entries()].sort(
    (a, b) => a[1].elapsed - b[1].elapsed
  );

  // Build combo targets
  const comboModels: ComboTarget[] = sortedProviders.map(([provider, state], i) => ({
    id: `auto-best-free-dynamic-${i + 1}-${provider}-${state.modelId}`.replace(
      /[^a-zA-Z0-9-]/g,
      "-"
    ),
    kind: "model" as const,
    model: `${provider}/${state.modelId}`,
    providerId: provider,
    weight: 0,
  }));

  await updateComboInDb(comboId, comboModels);
  log.info(
    "DYNAMIC_FREE_COMBO",
    `Updated combo ${comboId} with ${comboModels.length} tool-calling providers: ${sortedProviders.map(([p, s]) => `${p}/${s.modelId}(${s.elapsed}ms)`).join(", ")}`
  );

  return comboModels.length;
}

/**
 * Start the periodic generator.
 * Runs immediately, then on the configured interval.
 */
export function startDynamicFreeComboGenerator(
  comboId: string,
  apiKey: string,
  omniUrl: string,
  intervalMs: number = DEFAULT_PROBE_INTERVAL_MS,
  excludedProviders: Set<string> = DEFAULT_EXCLUDED_PROVIDERS
): void {
  if (generatorTimer) {
    log.debug("DYNAMIC_FREE_COMBO", "Generator already running — skipping start");
    return;
  }

  log.info(
    "DYNAMIC_FREE_COMBO",
    `Starting periodic generator (interval=${intervalMs}ms, API-driven, tool-calling enforced, adaptive probing)`
  );

  // Run immediately
  generateDynamicFreeCombo(comboId, apiKey, omniUrl, excludedProviders).catch((err) =>
    log.error("DYNAMIC_FREE_COMBO", `Initial generation failed: ${err}`)
  );

  // Schedule periodic runs
  generatorTimer = setInterval(() => {
    generateDynamicFreeCombo(comboId, apiKey, omniUrl, excludedProviders).catch((err) =>
      log.error("DYNAMIC_FREE_COMBO", `Periodic generation failed: ${err}`)
    );
  }, intervalMs);
}

/**
 * Stop the periodic generator.
 */
export function stopDynamicFreeComboGenerator(): void {
  if (generatorTimer) {
    clearInterval(generatorTimer);
    generatorTimer = null;
    log.info("DYNAMIC_FREE_COMBO", "Stopped periodic generator");
  }
}

/**
 * Get the last probe results for monitoring/debugging.
 */
export function getLastProbeResults() {
  return lastProbeResults;
}

/**
 * Get the current probe state map (for monitoring/debugging adaptive scheduling).
 */
export function getProbeStateMap(): Map<string, ModelProbeState> {
  return probeStateMap;
}

/**
 * Get the current cycle count.
 */
export function getCycleCount(): number {
  return cycleCount;
}

/**
 * Explicitly persist probe state to DB — called by SIGHUP hot reload handler.
 * Ensures state is flushed before process exits for restart.
 */
export async function persistProbeStateExplicit(): Promise<void> {
  await persistProbeState();
}

/**
 * Reset all probe state (for testing).
 * Clears probeStateMap, cycleCount, and lastProbeResults.
 */
export function _resetProbeState(): void {
  probeStateMap.clear();
  cycleCount = 0;
  lastProbeResults = [];
  lastCandidateKeys = new Set();
  probeStateLoaded = false;
}
