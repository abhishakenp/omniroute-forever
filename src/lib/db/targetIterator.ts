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
const TERMINAL_STATUSES = ["expired", "banned", "credits_exhausted"] as const;

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
              OR test_status NOT IN (${sqlList(SOFT_FAILURE_STATUSES)})
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
        WHERE test_status IN (${sqlList(SOFT_FAILURE_STATUSES)})
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

export interface TargetRow {
  connectionId: string;
  provider: string;
  modelId: string;
  modelStr: string; // "provider/model"
  apiKey: string | null;
  authType: string | null;
  defaultModel: string | null;
  priority: number;
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

  constructor(
    opts: {
      freeProvidersOnly?: boolean;
      excludedProviders?: Set<string>;
      specificProvider?: string;
      specificModel?: string;
    } = {}
  ) {
    this.freeProvidersOnly = opts.freeProvidersOnly ?? false;
    this.excludedProviders = opts.excludedProviders ?? new Set();
    this.specificProvider = opts.specificProvider ?? null;
    this.specificModel = opts.specificModel ?? null;
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

    // Params order: [specificProvider?, ...freeIds?, now, now]
    //   — CANDIDATE_PREDICATE binds `now` twice.
    const params: unknown[] = [];
    if (this.specificProvider) params.push(this.specificProvider);
    params.push(...freeIds);
    params.push(now, now);

    const rows = this.db
      .prepare(
        `SELECT id, provider, api_key, auth_type, default_model, priority, test_status, rate_limited_until
         FROM provider_connections
         WHERE is_active = 1
           ${providerFilter}${freeFilter}${CANDIDATE_PREDICATE}
         ORDER BY priority DESC, backoff_level ASC, last_used_at ASC
         LIMIT 200`
      )
      .all(...params) as Array<{
      id: string;
      provider: string;
      api_key: string | null;
      auth_type: string | null;
      default_model: string | null;
      priority: number;
    }>;

    for (const conn of rows) {
      if (this.triedConnectionIds.has(conn.id)) continue;
      if (this.excludedProviders.has(conn.provider)) continue;

      // Get synced models for this connection's provider
      const modelRows = this.db
        .prepare(
          `SELECT value FROM key_value
           WHERE namespace = 'syncedAvailableModels'
             AND (key = ? OR key LIKE ?)
           LIMIT 1`
        )
        .get(conn.provider, `${conn.provider}:%`) as { value: string } | undefined;

      let modelIds: string[] = [];
      if (modelRows?.value) {
        try {
          const parsed = JSON.parse(modelRows.value);
          if (Array.isArray(parsed)) {
            modelIds = parsed
              .map((m: { id?: string }) => (typeof m?.id === "string" ? m.id : ""))
              .filter(Boolean)
              .slice(0, 5); // cap models per provider
          }
        } catch {
          // ignore JSON parse errors
        }
      }

      // Fall back to registry models for no-auth providers (opencode, auggie, etc.)
      if (modelIds.length === 0) {
        const registry = getProviderRegistry();
        const entry = registry[conn.provider];
        if (entry?.models && Array.isArray(entry.models)) {
          modelIds = entry.models
            .map((m: { id?: string }) => (typeof m?.id === "string" ? m.id : ""))
            .filter(Boolean)
            .slice(0, 3);
        }
      }

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

        return {
          connectionId: conn.id,
          provider: conn.provider,
          modelId,
          modelStr: `${conn.provider}/${modelId}`,
          apiKey: decrypted.apiKey ?? null,
          authType: conn.auth_type,
          defaultModel: conn.default_model,
          priority: conn.priority,
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
                         OR test_status NOT IN (${sqlList(SOFT_FAILURE_STATUSES)})
                         OR (rate_limited_until IS NOT NULL AND rate_limited_until < ?)
                      )
                      AND (rate_limited_until IS NULL OR rate_limited_until < ?)
                     THEN 1 ELSE 0 END
              ) = 0`
          )
          .all(now, now) as Array<{ provider: string }>
      ).map((r) => r.provider)
    );

    for (const [providerId, entry] of noAuthEntries) {
      if (this.excludedProviders.has(providerId)) continue;
      if (quarantinedProviders.has(providerId)) continue;
      // Same free-only restriction as the connection query above.
      if (this.freeProvidersOnly && !getFreeProviderIds().has(providerId)) continue;
      if (!isKeylessRegistryProvider(entry)) continue;
      if (!entry.models || !Array.isArray(entry.models)) continue;

      for (const model of entry.models.slice(0, 3)) {
        const modelId = typeof model?.id === "string" ? model.id : "";
        if (!modelId) continue;
        // For specific provider requests, filter to the requested model
        if (this.specificModel && modelId !== this.specificModel) continue;
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
      // Insufficient credits — mark as credits_exhausted (provisioner will refresh)
      this.db
        .prepare(
          `UPDATE provider_connections
           SET test_status = 'credits_exhausted', last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(`HTTP ${status}`, new Date().toISOString(), connectionId);
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
             test_status = CASE WHEN test_status IN (${sqlList(SOFT_FAILURE_STATUSES)})
                                THEN NULL ELSE test_status END,
             last_error = CASE WHEN test_status IN (${sqlList(SOFT_FAILURE_STATUSES)})
                               THEN NULL ELSE last_error END,
             last_error_at = CASE WHEN test_status IN (${sqlList(SOFT_FAILURE_STATUSES)})
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
