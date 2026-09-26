/**
 * SQLite iterator for combo routing — one provider/model/apikey at a time.
 *
 * Replaces the in-memory target array pattern. Each call to `nextTarget()`
 * runs a single SQLite query that returns the next usable provider/model/
 * connection, filtered by:
 *   - is_active = 1
 *   - not in a TERMINAL status (expired / banned / credits_exhausted)
 *   - not in a SOFT-failure status (error / unavailable) whose cooldown is
 *     still running — soft failures expire, terminal ones do not
 *   - rate_limited_until IS NULL OR rate_limited_until < now
 *   - when `freeProvidersOnly` is set, the provider is actually free
 *   - provider has synced models
 *
 * Ordered by priority, then backoff_level (so a repeatedly failing connection
 * sinks behind healthy ones), then least-recently-used.
 *
 * The caller tries the target, and on failure calls `markFailed()` which
 * updates SQLite directly. The next `nextTarget()` call skips it.
 *
 * Zero in-memory state. Zero caching. One row at a time.
 */

import { getDbInstance } from "./core.ts";
import { decryptConnectionFields } from "./encryption.ts";
import { getProviderRegistry } from "../../../open-sse/services/autoCombo/providerRegistryAccessor.ts";
import type { RegistryEntry } from "../../../open-sse/config/providers/shared.ts";
import { selectFittingModels, type ModelLike } from "./modelFitness.ts";
import { parseProviderSpecificData } from "./webSessionDedup.ts";

/**
 * True when a registry provider can serve a request with no stored credential.
 *
 * `authType: "none"` is the registry's own runtime signal — it is what the
 * executor and auth paths key off, and today it selects exactly the local/
 * anonymous transports (auggie, duckduckgo-web, felo-web).
 *
 * This predicate used to also test `entry.noAuth !== true`. `noAuth` is not a
 * field on RegistryEntry and is set by no registry entry, so that test was
 * always `undefined !== true` — it changed nothing, and reading a property the
 * type does not declare is what kept the mistake invisible. The `noAuth: true`
 * flag does exist, but on the provider *catalog*
 * (src/shared/constants/providers/noauth.ts), which is dashboard presentation
 * metadata and is never merged into the routing registry. Routing must not
 * pretend to read it; if that catalog flag should ever drive routing it has to
 * be plumbed into RegistryEntry deliberately.
 */
function isKeylessRegistryProvider(entry: RegistryEntry): boolean {
  return entry.authType === "none";
}

/**
 * Statuses that must never come back on their own. A key in one of these needs
 * new credentials, an operator action, or the provisioner — retrying it is pure
 * waste. Mirrors `isTerminalConnectionStatus` (src/sse/services/auth.ts).
 */
import {
  loadKeylessHealth,
  recordKeylessFailure,
  clearKeylessFailure,
  loadIncapableModels,
  isKeylessConnectionId,
  providerFromKeylessId,
} from "./keylessHealth.ts";

const TERMINAL_STATUSES = ["expired", "banned", "revoked"] as const;

/**
 * When a credential stops being "broken right now" and becomes "gone".
 *
 * The comment on SOFT_FAILURE_STATUSES below is right that one 401 proves
 * nothing — a rotated key, a refresh blip and a revoked credential are
 * identical at the HTTP layer, and writing a headstone on the first one is how
 * this pool lost 163 connections before. But the opposite error has a cost
 * too, and it is the one running now: 355 connections on this machine carry an
 * auth failure and `is_active = 1`, 215 of them on mistral alone, some at
 * `backoff_level` 30. Every one is retried forever, and every retry spends an
 * attempt out of the 60s budget a real request has before it gets a 503.
 *
 * The number of *consecutive* failures is what separates the two cases, and
 * `backoff_level` already counts exactly that: markFailed increments it,
 * markSucceeded clears it, so a level of N means N failures with no success in
 * between. With the escalating schedule (5m, 10m, 20m … capped at 12h), level
 * 12 is reached only after roughly seventy hours of retrying. Nothing that a
 * rotation, a refresh or an upstream blip would have fixed is still failing
 * after seventy hours of attempts.
 *
 * Deliberately auth-only. `credits_exhausted` keeps its cooldown and its way
 * back, because a free tier's quota really does reset on a clock and killing
 * those is the exact mistake documented above.
 */
export const AUTH_DEAD_AFTER_LEVEL = 12;

/**
 * Quota exhaustion is NOT terminal, and treating it as terminal cost this pool
 * most of its capacity.
 *
 * `credits_exhausted` was in TERMINAL_STATUSES, and nothing in the daemon has
 * ever written it back to NULL — `markSucceeded` only clears soft statuses, and
 * a connection in a terminal status is never selected, so it can never succeed
 * and clear itself. Measured on this machine: 163 connections stuck there,
 * including all 123 openrouter rows (since 2026-08-30) and all 23 bazaarlink
 * rows (since 2026-09-01). Those are free tiers whose quota resets on a clock;
 * they were healthy again within hours and stayed locked out for days.
 *
 * That is what collapsed `auto/best-free` onto cohere and dahl alone, and a
 * two-provider pool is why a busy moment reads as `503 All providers
 * exhausted` (measured: 67,046 upstream 429s).
 *
 * So quota gets the same shape the 401 fix got: a real cooldown and an
 * escalating backoff, not a headstone. A provider that is genuinely out of
 * credit costs one call per cooldown window; a provider whose quota reset comes
 * back into service on its own.
 */
const QUOTA_STATUSES = ["credits_exhausted"] as const;

/** First retry ~1h after a 402, doubling to the 12h cap. */
const QUOTA_BACKOFF_BASE_MS = 60 * 60_000;

/**
 * Statuses that mean "broken right now", not "broken forever".
 *
 * A 401 is the obvious case: a rotated key, a refreshed token, a provider auth
 * blip and a genuinely revoked credential all look identical at the HTTP layer.
 * Writing a permanent status for one is how a recoverable key becomes a corpse.
 */
const SOFT_FAILURE_STATUSES = ["error", "unavailable"] as const;

/** Escalating cooldown for soft failures: 5min, 10min, 20min … capped at 12h. */
const SOFT_BACKOFF_BASE_MS = 5 * 60_000;
const SOFT_BACKOFF_MAX_MS = 12 * 60 * 60_000;

export function softBackoffMs(backoffLevel: number): number {
  const level = Number.isFinite(backoffLevel) && backoffLevel > 0 ? Math.floor(backoffLevel) : 0;
  // Cap the exponent before shifting so a large level can't overflow to 0.
  const capped = Math.min(level, 20);
  return Math.min(SOFT_BACKOFF_BASE_MS * 2 ** capped, SOFT_BACKOFF_MAX_MS);
}

/** Escalating cooldown for quota exhaustion: 1h, 2h, 4h … capped at 12h. */
export function quotaBackoffMs(backoffLevel: number): number {
  const level = Number.isFinite(backoffLevel) && backoffLevel > 0 ? Math.floor(backoffLevel) : 0;
  const capped = Math.min(level, 20);
  return Math.min(QUOTA_BACKOFF_BASE_MS * 2 ** capped, SOFT_BACKOFF_MAX_MS);
}

/** SQL list literal, e.g. `'expired', 'banned'`. */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

/**
 * The candidate predicate, in one place so the iterator and its helpers cannot
 * drift apart.
 *
 *   - terminal statuses are excluded outright;
 *   - a soft-failure status only excludes while its cooldown is still running —
 *     once the window elapses the connection is a candidate again, which is the
 *     entire recovery mechanism for the headless daemon (the proactive
 *     `connectionRecovery` scheduler is wired into Next.js instrumentation,
 *     which the Bun gateway never loads, and it only ever handled
 *     'unavailable' anyway);
 *   - a soft-failure row with NO cooldown at all is treated as still broken.
 *     Those are legacy rows written before cooldowns existed; the boot-time
 *     repair in reviveCooldownlessSoftFailures() gives them one so they get a
 *     path back instead of staying dead forever.
 */
const CANDIDATE_PREDICATE = `
           AND (test_status IS NULL OR test_status NOT IN (${sqlList(TERMINAL_STATUSES)}))
           AND (
                 test_status IS NULL
              OR test_status NOT IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
              OR (rate_limited_until IS NOT NULL AND rate_limited_until < ?)
           )
           AND (rate_limited_until IS NULL OR rate_limited_until < ?)`;

/**
 * Legacy backfill: soft-failure rows that carry NO cooldown.
 *
 * Before markFailed() attached a cooldown to a 401/403, it wrote
 * `test_status = 'error'` and nothing else. The candidate filter skips any soft
 * status without a cooldown, so those rows were unreachable forever — no
 * expiry, no sweeper (the proactive recovery scheduler lives in Next.js
 * instrumentation the Bun daemon never loads, and only ever handled
 * 'unavailable'), and they survived every restart. A key that was rotated,
 * briefly rate-limited, or fixed upstream had no way back into service.
 *
 * This gives each one a cooldown so it gets exactly one retry, and seeds
 * `backoff_level` high enough that the whole cohort sorts BEHIND every healthy
 * connection instead of stampeding to the front of the queue. One success
 * clears the state completely (see markSucceeded); continued failure escalates
 * toward the 12h cap.
 *
 * Idempotent: once a row has a cooldown it is never touched again.
 */
export const LEGACY_SOFT_FAILURE_BACKOFF_LEVEL = 4; // → 80 min before first retry

export function reviveCooldownlessSoftFailures(db: {
  prepare: (sql: string) => { run: (...args: unknown[]) => { changes?: number } };
}): number {
  const level = LEGACY_SOFT_FAILURE_BACKOFF_LEVEL;
  const retryAfter = new Date(Date.now() + softBackoffMs(level)).toISOString();
  const result = db
    .prepare(
      `UPDATE provider_connections
          SET backoff_level = MAX(COALESCE(backoff_level, 0), ?),
              rate_limited_until = ?
        WHERE test_status IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
          AND rate_limited_until IS NULL`
    )
    .run(level, retryAfter);
  return result?.changes ?? 0;
}

let _freeProviderIds: Set<string> | null = null;

/**
 * Provider ids that cost nothing extra to call.
 *
 * Two independent sources, unioned, because neither alone is correct:
 *
 *  - the provider catalog's `hasFree` flag — "this provider offers a free
 *    tier". Covers mistral, cohere, openrouter, bazaarlink, dahl, llm7,
 *    uncloseai, pollinations, ainative, api-airforce — i.e. every credentialed
 *    provider currently in service here.
 *  - the routing registry's `authType: "none"` — local or anonymous
 *    passthroughs OmniRoute is never billed for. Augment is `hasFree: false`
 *    in the catalog (the subscription is paid) yet spawning the already
 *    authenticated local CLI costs the router nothing, so it belongs in
 *    best-free.
 *
 * Deliberately NOT the hardcoded FREE_PROVIDERS list that used to sit unused in
 * thinGateway.ts. That list omitted dahl, llm7, uncloseai and bazaarlink —
 * every one of them free and in active service, and dahl serves a large share
 * of current traffic — so enforcing it verbatim would have silently deleted
 * healthy capacity rather than restricting to free capacity.
 *
 * Built once, lazily: the catalog is a few hundred KB of static literals and
 * there is no reason to pay for it until a best-free request actually arrives.
 */
export function getFreeProviderIds(): Set<string> {
  if (_freeProviderIds) return _freeProviderIds;
  const ids = new Set<string>();

  const registry = getProviderRegistry();
  for (const [id, entry] of Object.entries(registry)) {
    if (isKeylessRegistryProvider(entry)) ids.add(id);
  }

  try {
    // Required lazily so the module graph of a DB helper does not drag the
    // whole dashboard provider catalog in at import time.
    const { getProviderById } = require("@/shared/constants/providers") as {
      getProviderById: (id: string) => { hasFree?: boolean } | undefined;
    };
    for (const id of Object.keys(registry)) {
      if (getProviderById(id)?.hasFree === true) ids.add(id);
    }
  } catch {
    // Catalog unavailable (trimmed build / test harness): fall back to the
    // registry-only answer rather than failing the request.
  }

  _freeProviderIds = ids;
  return ids;
}

/** Test seam — drop the memoized free-provider set. */
export function __resetFreeProviderIds(): void {
  _freeProviderIds = null;
}

/**
 * What a model has actually refused, as opposed to what its catalog claims.
 *
 * A catalog entry is a marketing number. Cohere advertises a 128,000-token
 * window on `c4ai-aya-expanse-32b` and a Trial key refuses that model at
 * roughly 16k with `error_type: TOO_MANY_TOKENS` — measured 7,918 times in
 * ~/.omniroute/logs/omniroute.log. A static context filter cannot catch that;
 * only the provider's own behaviour can.
 *
 * So remember the smallest prompt each model has refused and stop offering it
 * anything that size or larger. Stored in `key_value` (namespace
 * `modelTokenCeiling`) so the lesson survives a restart, which is the whole
 * point — otherwise every boot re-learns it at the cost of another few thousand
 * doomed upstream calls.
 */
const REFUSAL_NAMESPACE = "modelTokenCeiling";

export function loadRefusalCeilings(db: {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
}): Map<string, number> {
  const ceilings = new Map<string, number>();
  try {
    const rows = db
      .prepare(`SELECT key, value FROM key_value WHERE namespace = ?`)
      .all(REFUSAL_NAMESPACE) as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const parsed = Number(row.value);
      if (Number.isFinite(parsed) && parsed > 0) ceilings.set(row.key, parsed);
    }
  } catch {
    // No table / no rows — an empty map simply means nothing learned yet.
  }
  return ceilings;
}

/**
 * Record that `provider/model` refused a prompt of `promptTokens`.
 *
 * Keeps the SMALLEST refusal seen: the ceiling should converge downward onto
 * the real limit, and a single large refusal must not erase a smaller one.
 */
export function recordTokenRefusal(
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => unknown;
      get?: (...a: unknown[]) => unknown;
    };
  },
  modelStr: string,
  promptTokens: number
): void {
  if (!modelStr || !Number.isFinite(promptTokens) || promptTokens <= 0) return;
  try {
    const existing = db
      .prepare(`SELECT value FROM key_value WHERE namespace = ? AND key = ?`)
      .get?.(REFUSAL_NAMESPACE, modelStr) as { value: string } | undefined;
    const prior = existing ? Number(existing.value) : Number.POSITIVE_INFINITY;
    const next = Math.min(Number.isFinite(prior) ? prior : Number.POSITIVE_INFINITY, promptTokens);
    if (Number.isFinite(prior) && next >= prior) return;
    db.prepare(
      `INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
    ).run(REFUSAL_NAMESPACE, modelStr, String(next));
  } catch {
    // Learning is an optimisation; never fail a request because it could not be stored.
  }
}

export interface TargetRow {
  connectionId: string;
  provider: string;
  modelId: string;
  modelStr: string; // "provider/model"
  apiKey: string | null;
  authType: string | null;
  defaultModel: string | null;
  priority: number;
  /**
   * Connection-specific base URL from `provider_specific_data.baseUrl`.
   *
   * Local providers (vllm, ollama-local, lm-studio, llama-cpp, …) are NOT in
   * the OpenSSE routing REGISTRY — they live in LOCAL_PROVIDERS for the
   * dashboard. Each connection carries its own upstream URL in
   * `provider_specific_data.baseUrl`, and the thin gateway must read it
   * here rather than looking up a registry entry that does not exist.
   */
  baseUrl: string | null;
}

// Track which connections we've already tried in this request so we don't retry them.
// This is request-scoped (one iterator instance per request), not global state.
export class TargetIterator {
  private triedConnectionIds = new Set<string>();
  private triedProviderModels = new Set<string>(); // "provider:modelId"
  private triedNoAuth = false;
  private db = getDbInstance();
  private freeProvidersOnly: boolean;
  private excludedProviders: Set<string>;
  private specificProvider: string | null;
  private specificModel: string | null;
  /**
   * Consumer tag this request routes for (e.g. "iris/always"), or null for
   * general traffic. Reserved connections (`reserved_for IS NOT NULL`) are
   * invisible to general traffic — an explicit invariant, not an optimisation:
   * a key set aside for one consumer must never be spent by anyone else.
   */
  private reservedFor: string | null;
  /** Size of the request being routed — models too small for it are not candidates. */
  private promptTokens: number;
  private outputTokens: number;
  private refusedAbove: Map<string, number>;
  /**
   * Cooldowns for keyless (`noauth-*`) targets, which own no
   * `provider_connections` row and so had nowhere to record a failure.
   * See keylessHealth.ts.
   */
  private keylessHealth: Map<string, { level: number; until: number }>;
  /** `provider/model` pairs an upstream has said it cannot chat with — permanent. */
  private incapableModels: Set<string>;

  constructor(
    opts: {
      freeProvidersOnly?: boolean;
      excludedProviders?: Set<string>;
      specificProvider?: string;
      specificModel?: string;
      /** Estimated prompt tokens for this request (see modelFitness.ts). */
      promptTokens?: number;
      /** Tokens the reply may occupy, which the window must also hold. */
      outputTokens?: number;
      /**
       * Consumer tag (e.g. "iris/always"). When set, connections reserved for
       * this tag are tried first and the general pool is the fallback. When
       * unset, reserved connections are excluded entirely.
       */
      reservedFor?: string;
    } = {}
  ) {
    this.freeProvidersOnly = opts.freeProvidersOnly ?? false;
    this.excludedProviders = opts.excludedProviders ?? new Set();
    this.specificProvider = opts.specificProvider ?? null;
    this.specificModel = opts.specificModel ?? null;
    this.promptTokens = opts.promptTokens ?? 0;
    this.outputTokens = opts.outputTokens ?? 0;
    this.reservedFor = opts.reservedFor ?? null;
    this.refusedAbove = this.promptTokens > 0 ? loadRefusalCeilings(this.db) : new Map();
    this.keylessHealth = loadKeylessHealth(this.db);
    this.incapableModels = loadIncapableModels(this.db);
  }

  /** True when a model has been proven permanently unable to serve chat. */
  private isIncapable(modelStr: string): boolean {
    return this.incapableModels.has(modelStr);
  }

  /**
   * Get the next available target. Returns null when exhausted.
   * Each call is a single SQLite query — no caching, no in-memory arrays.
   */
  nextTarget(): TargetRow | null {
    // Get active connections that haven't been tried yet, ordered by priority.
    // Filter by specific provider when set (for direct provider/model requests).
    const now = new Date().toISOString();
    const providerFilter = this.specificProvider ? `AND provider = ?` : "";
    // `auto/best-free` must actually mean free — restrict the candidate set to
    // free providers instead of quietly iterating the paid pool. Applied in SQL
    // so the LIMIT below counts eligible rows, not rows we are about to discard.
    const freeIds = this.freeProvidersOnly ? [...getFreeProviderIds()] : [];
    const freeFilter =
      this.freeProvidersOnly && freeIds.length > 0
        ? ` AND provider IN (${freeIds.map(() => "?").join(", ")})`
        : "";

    // Reservation filter. A reserved connection belongs to exactly one
    // consumer: general traffic must never see it (hence the `IS NULL` arm
    // when no tag is set), and a tagged request sees its own reserved rows
    // plus the general pool as fallback.
    const reservedFilter = this.reservedFor
      ? ` AND (reserved_for IS NULL OR reserved_for = ?)`
      : ` AND reserved_for IS NULL`;
    // Reserved rows sort ahead of the general pool so the dedicated key is
    // spent first and the shared pool only catches the overflow.
    const reservedOrder = this.reservedFor ? `(reserved_for IS NOT NULL) DESC, ` : "";

    // Params order: [specificProvider?, ...freeIds?, reservedFor?, now, now]
    //   — matches the `?` order in the SQL below: providerFilter, freeFilter,
    //     reservedFilter, then CANDIDATE_PREDICATE which binds `now` twice.
    const params: unknown[] = [];
    if (this.specificProvider) params.push(this.specificProvider);
    params.push(...freeIds);
    if (this.reservedFor) params.push(this.reservedFor);
    params.push(now, now);

    const rows = this.db
      .prepare(
        `SELECT id, provider, api_key, auth_type, default_model, priority, test_status, rate_limited_until, provider_specific_data
         FROM provider_connections
         WHERE is_active = 1
           ${providerFilter}${freeFilter}${reservedFilter}${CANDIDATE_PREDICATE}
         ORDER BY ${reservedOrder}priority DESC, backoff_level ASC, last_used_at ASC
         LIMIT 200`
      )
      .all(...params) as Array<{
      id: string;
      provider: string;
      api_key: string | null;
      auth_type: string | null;
      default_model: string | null;
      priority: number;
      provider_specific_data: string | null;
    }>;

    // Batch-fetch synced models for ALL candidate providers in ONE query,
    // instead of one query per connection (the N+1 that produced up to 202
    // SQLite queries per nextTarget() call). Group by provider so the loop
    // below can look up models without touching the database again.
    // Keys are stored as '<providerId>:<connectionId>' or bare '<providerId>'.
    const candidateProviders = new Set(rows.map((r) => r.provider));
    const syncedModels = new Map<string, ModelLike[]>();
    if (candidateProviders.size > 0) {
      // One LIKE pattern per provider: 'provider:%' matches sub-keys; the
      // bare provider key is matched by the first LIKE too (prefix match on
      // 'provider:' would miss the bare key, so we also check equality).
      // Using a single query with OR is simpler and still one round-trip.
      const likePatterns = [...candidateProviders].flatMap((p) => [p, `${p}:%`]);
      const placeholders = likePatterns.map(() => "?").join(", ");
      const modelRows = this.db
        .prepare(
          `SELECT key, value FROM key_value
           WHERE namespace = 'syncedAvailableModels'
             AND key IN (${placeholders})`
        )
        .all(...likePatterns) as Array<{ key: string; value: string }>;
      for (const row of modelRows) {
        // Extract the provider from the key (either bare 'provider' or 'provider:connId')
        const provider = row.key.split(":")[0];
        if (!syncedModels.has(provider)) {
          try {
            const parsed = JSON.parse(row.value);
            if (Array.isArray(parsed)) syncedModels.set(provider, parsed as ModelLike[]);
          } catch {
            // ignore JSON parse errors
          }
        }
      }
    }

    for (const conn of rows) {
      if (this.triedConnectionIds.has(conn.id)) continue;
      if (this.excludedProviders.has(conn.provider)) continue;

      // Look up the batched models for this connection's provider — no
      // per-connection query. The old code did one SELECT per connection
      // here, which was the N+1.
      const modelRows = syncedModels.get(conn.provider);

      // Keep the WHOLE model record, not just the id: `inputTokenLimit` is the
      // only thing that can tell a 436k-window model from an 8,992-token one,
      // and dropping it here is what made every candidate look interchangeable.
      let models: ModelLike[] = [];
      if (modelRows) {
        models = modelRows;
      }

      const registryForModels = getProviderRegistry();
      const providerEntry = registryForModels[conn.provider];
      // Fall back to registry models for no-auth providers (opencode, auggie, etc.)
      if (models.length === 0 && providerEntry?.models && Array.isArray(providerEntry.models)) {
        models = providerEntry.models as ModelLike[];
      }

      // Rank by usable window and drop what categorically cannot serve this
      // request. Ordering is the half that matters: the measured cohere
      // sequence spent three TOO_MANY_TOKENS refusals and one
      // unsupported-endpoint refusal before reaching the model that works.
      let modelIds = selectFittingModels(models, {
        promptTokens: this.promptTokens,
        outputTokens: this.outputTokens,
        providerDefaultContext: providerEntry?.defaultContextLength,
        refusedAbove: this.refusedAbove,
        provider: conn.provider,
        cap: 5,
      });

      // If a specific model is requested, filter to only that model
      if (this.specificModel) {
        modelIds = modelIds.filter((m) => m === this.specificModel);
        if (modelIds.length === 0) modelIds = [this.specificModel]; // trust the user
      }

      // Fall back to default_model if still no models
      if (modelIds.length === 0 && conn.default_model) {
        modelIds = [conn.default_model];
      }

      for (const modelId of modelIds) {
        const key = `${conn.provider}:${modelId}`;
        if (this.triedProviderModels.has(key)) continue;

        // Found an untried provider/model/connection — return it
        this.triedConnectionIds.add(conn.id);
        this.triedProviderModels.add(key);

        // Decrypt the API key before returning
        const decrypted = decryptConnectionFields({
          apiKey: conn.api_key,
          accessToken: undefined,
          refreshToken: undefined,
          idToken: undefined,
        });

        // Extract the connection-specific base URL for local providers (vllm,
        // ollama-local, lm-studio, …). These providers are not in the OpenSSE
        // routing REGISTRY; each connection carries its own upstream URL in
        // provider_specific_data.baseUrl, and the thin gateway reads it from
        // the target row instead of a registry lookup that would miss.
        const psd = parseProviderSpecificData(conn.provider_specific_data);
        const connBaseUrl =
          psd && typeof psd.baseUrl === "string" && psd.baseUrl.trim()
            ? psd.baseUrl.trim()
            : null;

        // A model the upstream has said it cannot chat with is not a candidate,
        // no matter how healthy the credential in front of it is.
        if (this.isIncapable(`${conn.provider}/${modelId}`)) continue;

        return {
          connectionId: conn.id,
          provider: conn.provider,
          modelId,
          modelStr: `${conn.provider}/${modelId}`,
          apiKey: decrypted.apiKey ?? null,
          authType: conn.auth_type,
          defaultModel: conn.default_model,
          priority: conn.priority,
          baseUrl: connBaseUrl,
        };
      }
    }

    // No more connection-based targets — try no-auth providers from the registry.
    // For direct provider/model requests (specificProvider set), only check that
    // specific provider if it's a no-auth provider with no DB connection.
    const registry = getProviderRegistry();
    const noAuthEntries = this.specificProvider
      ? Object.entries(registry).filter(([id]) => id === this.specificProvider)
      : Object.entries(registry);

    // A provider that owns connection rows is governed by those rows' health.
    // If every one of its rows is quarantined (401 → 'error', 402 →
    // 'credits_exhausted') or still cooling down, do NOT resurrect it here —
    // the registry no-auth fallback would otherwise bypass the quarantine and
    // keep hammering a credential/CLI we already know is dead.
    const quarantinedProviders = new Set(
      (
        this.db
          .prepare(
            `SELECT provider FROM provider_connections
              GROUP BY provider
              HAVING SUM(
                CASE WHEN is_active = 1
                      AND (test_status IS NULL OR test_status NOT IN (${sqlList(TERMINAL_STATUSES)}))
                      AND (
                            test_status IS NULL
                         OR test_status NOT IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
                         OR (rate_limited_until IS NOT NULL AND rate_limited_until < ?)
                      )
                      AND (rate_limited_until IS NULL OR rate_limited_until < ?)
                     THEN 1 ELSE 0 END
              ) = 0`
          )
          .all(now, now) as Array<{ provider: string }>
      ).map((r) => r.provider)
    );

    const nowMs = Date.now();
    for (const [providerId, entry] of noAuthEntries) {
      if (this.excludedProviders.has(providerId)) continue;
      if (quarantinedProviders.has(providerId)) continue;
      // Keyless providers own no connection row, so `quarantinedProviders`
      // (a GROUP BY over provider_connections) can never contain them — a
      // provider with zero rows produces no group. Their cooldown lives in
      // key_value instead; without this check a rate-limited scraper was
      // re-offered on every single request. See keylessHealth.ts.
      const health = this.keylessHealth.get(providerId);
      if (health && health.until > nowMs) continue;
      // Same free-only restriction as the connection query above.
      if (this.freeProvidersOnly && !getFreeProviderIds().has(providerId)) continue;
      if (!isKeylessRegistryProvider(entry)) continue;
      if (!entry.models || !Array.isArray(entry.models)) continue;

      const keylessModelIds = selectFittingModels(entry.models as ModelLike[], {
        promptTokens: this.promptTokens,
        outputTokens: this.outputTokens,
        providerDefaultContext: entry.defaultContextLength,
        refusedAbove: this.refusedAbove,
        provider: providerId,
        cap: 3,
      });
      for (const modelId of keylessModelIds) {
        if (!modelId) continue;
        // For specific provider requests, filter to the requested model
        if (this.specificModel && modelId !== this.specificModel) continue;
        if (this.isIncapable(`${providerId}/${modelId}`)) continue;
        const key = `${providerId}:${modelId}`;
        if (this.triedProviderModels.has(key)) continue;
        this.triedProviderModels.add(key);

        return {
          connectionId: `noauth-${providerId}`,
          provider: providerId,
          modelId,
          modelStr: `${providerId}/${modelId}`,
          apiKey: null,
          authType: "none",
          defaultModel: null,
          priority: -1, // no-auth providers are lower priority
          baseUrl: null,
        };
      }
    }

    return null; // exhausted
  }

  /**
   * Mark a target as failed (rate-limited or errored).
   * Updates SQLite directly so the next nextTarget() call skips it.
   */
  markFailed(connectionId: string, status: number, cooldownMs: number = 60_000): void {
    // Keyless targets have no row to UPDATE. Every branch below ends in
    // `WHERE id = ?` against provider_connections, so for a `noauth-*` id the
    // statement matched 0 rows and the failure was thrown away — which is how
    // felo-web and duckduckgo-web accumulated ~21k 429s between them without
    // ever cooling down. Route them to their own store instead.
    if (isKeylessConnectionId(connectionId)) {
      const provider = providerFromKeylessId(connectionId);
      const health = recordKeylessFailure(this.db, provider, cooldownMs);
      // Keep the in-memory view consistent so the SAME request does not
      // re-offer the provider before the next iterator is constructed.
      if (health) this.keylessHealth.set(provider, health);
      return;
    }
    const retryAfter = new Date(Date.now() + cooldownMs).toISOString();
    if (status === 429) {
      this.db
        .prepare(
          `UPDATE provider_connections
           SET rate_limited_until = ?, last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(retryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if ([401, 403].includes(status)) {
      // A 401/403 is NOT terminal. A rotated key, a token that needs refreshing,
      // a provider auth blip and a genuinely revoked credential are
      // indistinguishable here, so this must leave a way back: write the soft
      // 'error' status TOGETHER WITH an escalating cooldown, and bump
      // backoff_level so the candidate ordering pushes a repeat offender behind
      // everything healthy. Without the cooldown the row was dead forever —
      // nothing in the Bun daemon ever cleared it, and it survived restarts.
      // Same shape as the fix `/api/providers/[id]/test` got in #9623.
      const row = this.db
        .prepare(`SELECT backoff_level FROM provider_connections WHERE id = ?`)
        .get(connectionId) as { backoff_level: number | null } | undefined;
      const nextLevel = Math.max(0, row?.backoff_level ?? 0) + 1;
      // ... until it has failed enough consecutive times that "blip" stops
      // being a possible explanation. See AUTH_DEAD_AFTER_LEVEL: this is the
      // point where the row stops costing every future request an attempt.
      if (nextLevel >= AUTH_DEAD_AFTER_LEVEL) {
        this.db
          .prepare(
            `UPDATE provider_connections
             SET test_status = 'revoked',
                 backoff_level = ?,
                 rate_limited_until = NULL,
                 last_error = ?,
                 last_error_at = ?
             WHERE id = ?`
          )
          .run(
            nextLevel,
            `HTTP ${status} — retired after ${nextLevel} consecutive auth failures`,
            new Date().toISOString(),
            connectionId
          );
        return;
      }
      const softRetryAfter = new Date(Date.now() + softBackoffMs(nextLevel - 1)).toISOString();
      this.db
        .prepare(
          `UPDATE provider_connections
           SET test_status = 'error',
               backoff_level = ?,
               rate_limited_until = ?,
               last_error = ?,
               last_error_at = ?
           WHERE id = ?`
        )
        .run(nextLevel, softRetryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if (status === 402) {
      // Out of credit for now — NOT forever. Write the quota status together
      // with a cooldown and an escalating backoff, so a free tier that resets
      // on a clock comes back on its own. Without the cooldown this row was
      // unreachable for good: nothing ever cleared the status, and a row that
      // is never selected can never succeed and clear itself.
      const row = this.db
        .prepare(`SELECT backoff_level FROM provider_connections WHERE id = ?`)
        .get(connectionId) as { backoff_level: number | null } | undefined;
      const nextLevel = Math.max(0, row?.backoff_level ?? 0) + 1;
      const quotaRetryAfter = new Date(Date.now() + quotaBackoffMs(nextLevel - 1)).toISOString();
      this.db
        .prepare(
          `UPDATE provider_connections
           SET test_status = 'credits_exhausted',
               backoff_level = ?,
               rate_limited_until = ?,
               last_error = ?,
               last_error_at = ?
           WHERE id = ?`
        )
        .run(nextLevel, quotaRetryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if ([500, 502, 503, 504].includes(status)) {
      // Short cooldown for server errors — might be transient
      this.db
        .prepare(
          `UPDATE provider_connections
           SET rate_limited_until = ?, last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(retryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    }
    // 400 = model-specific error, don't mark connection — just skip this model
  }

  /**
   * Mark a target as succeeded — update last_used_at for LKGP-style ordering.
   */
  markSucceeded(connectionId: string): void {
    // Keyless targets clear their backoff in key_value, not in a row. A scraper
    // that recovers must come straight back — no headstones.
    if (isKeylessConnectionId(connectionId)) {
      const provider = providerFromKeylessId(connectionId);
      clearKeylessFailure(this.db, provider);
      this.keylessHealth.delete(provider);
      return;
    }
    // A success is proof the credential works, so clear the soft-failure state
    // outright — otherwise a connection that recovered would keep its 'error'
    // status and its escalating backoff, and would be pushed to the back of the
    // queue (or filtered out again on the next cooldown write) despite working.
    // Terminal statuses are left alone; they are never selected in the first
    // place, so reaching here with one set would itself be a bug.
    this.db
      .prepare(
        `UPDATE provider_connections
         SET last_used_at = ?,
             backoff_level = 0,
             rate_limited_until = NULL,
             test_status = CASE WHEN test_status IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
                                THEN NULL ELSE test_status END,
             last_error = CASE WHEN test_status IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
                               THEN NULL ELSE last_error END,
             last_error_at = CASE WHEN test_status IN (${sqlList([...SOFT_FAILURE_STATUSES, ...QUOTA_STATUSES])})
                                  THEN NULL ELSE last_error_at END
         WHERE id = ?`
      )
      .run(new Date().toISOString(), connectionId);
  }

  /**
   * Have we tried all available targets?
   */
  get isExhausted(): boolean {
    return this.triedConnectionIds.size > 0 && this.nextTarget() === null;
  }

  /**
   * Which providers have we tried?
   */
  get triedProviders(): Set<string> {
    const providers = new Set<string>();
    // Extract from triedProviderModels which is "provider:modelId"
    for (const key of this.triedProviderModels) {
      const provider = key.split(":")[0];
      if (provider) providers.add(provider);
    }
    return providers;
  }
}
