/**
 * Health state for targets that have no `provider_connections` row.
 *
 * ## Why this exists
 *
 * `TargetIterator.nextTarget()` can return two kinds of target:
 *
 *   1. a credential — a real `provider_connections` row, whose health lives in
 *      that row (`test_status`, `backoff_level`, `rate_limited_until`); and
 *   2. a **keyless** target — a registry provider with `authType: "none"`,
 *      synthesised on the fly with the id `noauth-<provider>`.
 *
 * `markFailed()` writes health with `UPDATE provider_connections ... WHERE id = ?`.
 * For a keyless target that id matches no row, so the UPDATE changed 0 rows and
 * **every failure was silently discarded**. Nothing cooled down, nothing backed
 * off, and the `quarantinedProviders` guard could not help either: it is a
 * `GROUP BY provider` over `provider_connections`, and a provider with zero rows
 * produces no group, so it can never appear in the quarantine set.
 *
 * The measured consequence, from 300k lines of the production log:
 * 10,613 `felo-web` 429s and 10,423 `duckduckgo-web` 429s. Each new request
 * re-tried a scraper that had just been rate-limited, because nothing anywhere
 * remembered that it had.
 *
 * ## The deliberate choice: best-effort single-shot, not fake rotation
 *
 * The obvious alternative was to give these providers rotatable pseudo-identities
 * (a pool of sessions/cookies/UAs registered as pseudo-connections) so that
 * `nextTarget()` would have alternatives to fail over to. **That was rejected,
 * and the reason matters.** `duckduckgo-web` and `felo-web` are rate-limited by
 * *egress IP* — DuckDuckGo throttles VQD token acquisition, Felo throttles thread
 * creation. Every pseudo-identity this process could mint leaves from the same
 * IP, so N of them would fail together, in the same instant, for the same reason.
 * That is not failover; it is the same single-shot attempt billed N times, and it
 * would burn N slots out of the caller's 60s budget instead of one. Real rotation
 * needs a proxy pool, which is separate infrastructure that does not exist here.
 *
 * So these providers are treated as what they honestly are: **best-effort,
 * single-shot, last-resort** targets. Concretely:
 *
 *   - one attempt per request (already true — one synthetic target per provider);
 *   - a failure now *persists* a cooldown, so the next request skips them
 *     instead of re-proving the rate limit;
 *   - they keep `priority: -1` and are only reached after every credentialed
 *     target, so `auto` selection deprioritises them structurally;
 *   - a success clears the backoff, so a scraper that recovers comes straight
 *     back — no headstones (the mistake documented in targetIterator.ts).
 *
 * ## Storage
 *
 * The generic `key_value` table, exactly like the token-refusal ceilings above
 * it. No schema migration is required, and a keyless provider is not a
 * credential, so it does not belong in `provider_connections` — that table is
 * read by the dashboard, the encryption layer and the connection-test flows, all
 * of which would have to special-case a credential-less row.
 */

/** `key_value.namespace` holding per-provider keyless cooldowns. */
export const KEYLESS_HEALTH_NAMESPACE = "keylessProviderHealth";

/** `key_value.namespace` holding models proven incapable of chat completion. */
export const INCAPABLE_MODEL_NAMESPACE = "modelIncapableOfChat";

/** Escalating cooldown for a keyless failure: 5min, 10min, 20min … capped at 6h. */
const KEYLESS_BACKOFF_BASE_MS = 5 * 60_000;
const KEYLESS_BACKOFF_MAX_MS = 6 * 60 * 60_000;

export function keylessBackoffMs(level: number): number {
  const n = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0;
  const capped = Math.min(n, 20);
  return Math.min(KEYLESS_BACKOFF_BASE_MS * 2 ** capped, KEYLESS_BACKOFF_MAX_MS);
}

/** The synthetic connection id prefix used for keyless targets. */
export const NOAUTH_ID_PREFIX = "noauth-";

/** True when `connectionId` names a keyless target rather than a credential row. */
export function isKeylessConnectionId(connectionId: string): boolean {
  return typeof connectionId === "string" && connectionId.startsWith(NOAUTH_ID_PREFIX);
}

/** Extract the provider id from a `noauth-<provider>` connection id. */
export function providerFromKeylessId(connectionId: string): string {
  return connectionId.slice(NOAUTH_ID_PREFIX.length);
}

export interface KeylessHealth {
  /** Consecutive failures with no success in between. */
  level: number;
  /** Epoch ms until which this provider must not be offered. */
  until: number;
}

interface MinimalDb {
  prepare: (sql: string) => {
    all?: (...args: unknown[]) => unknown[];
    get?: (...args: unknown[]) => unknown;
    run?: (...args: unknown[]) => unknown;
  };
}

/**
 * Load every keyless provider's cooldown. Returns an empty map on any error —
 * health tracking is an optimisation and must never fail a request.
 */
export function loadKeylessHealth(db: MinimalDb): Map<string, KeylessHealth> {
  const out = new Map<string, KeylessHealth>();
  try {
    const rows = (db.prepare(`SELECT key, value FROM key_value WHERE namespace = ?`).all?.(
      KEYLESS_HEALTH_NAMESPACE
    ) ?? []) as Array<{ key: string; value: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as Partial<KeylessHealth>;
        const level = Number(parsed.level);
        const until = Number(parsed.until);
        if (!Number.isFinite(level) || !Number.isFinite(until)) continue;
        out.set(row.key, { level, until });
      } catch {
        // A malformed row is simply "nothing learned about this provider".
      }
    }
  } catch {
    // No table / no rows.
  }
  return out;
}

/**
 * Record a keyless-target failure and return the cooldown that was written.
 *
 * `cooldownMs` lets the caller impose a floor (the gateway already knows that
 * felo-web and duckduckgo-web reset on a long clock); the escalating backoff is
 * applied on top, and the longer of the two wins.
 */
export function recordKeylessFailure(
  db: MinimalDb,
  provider: string,
  cooldownMs = 0,
  now: number = Date.now()
): KeylessHealth | null {
  if (!provider) return null;
  try {
    const existing = db
      .prepare(`SELECT value FROM key_value WHERE namespace = ? AND key = ?`)
      .get?.(KEYLESS_HEALTH_NAMESPACE, provider) as { value: string } | undefined;
    let priorLevel = 0;
    if (existing) {
      try {
        const parsed = JSON.parse(existing.value) as Partial<KeylessHealth>;
        if (Number.isFinite(Number(parsed.level))) priorLevel = Math.max(0, Number(parsed.level));
      } catch {
        // Treat an unparseable prior as level 0.
      }
    }
    const level = priorLevel + 1;
    const until = now + Math.max(keylessBackoffMs(level - 1), Math.max(0, cooldownMs));
    const health: KeylessHealth = { level, until };
    db.prepare(
      `INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
    ).run?.(KEYLESS_HEALTH_NAMESPACE, provider, JSON.stringify(health));
    return health;
  } catch {
    return null;
  }
}

/** Clear a keyless provider's backoff after a success. */
export function clearKeylessFailure(db: MinimalDb, provider: string): void {
  if (!provider) return;
  try {
    db.prepare(`DELETE FROM key_value WHERE namespace = ? AND key = ?`).run?.(
      KEYLESS_HEALTH_NAMESPACE,
      provider
    );
  } catch {
    // Best effort.
  }
}

/**
 * Models an upstream has explicitly said it cannot chat with.
 *
 * This is a fact about the model, not about this moment, so unlike a cooldown it
 * has no expiry. Measured motivation: 8,913 identical
 * `invalid request: model 'cohere-transcribe-03-2026'` 400s — a speech-to-text
 * model that discovery imported into the chat pool. `refusalReason()` in
 * thinGateway.ts already *classified* that string as "model cannot chat", but
 * the classification was only ever used to build the final error message;
 * nothing removed the target, so it was offered again on the next request,
 * forever.
 */
export function loadIncapableModels(db: MinimalDb): Set<string> {
  const out = new Set<string>();
  try {
    const rows = (db.prepare(`SELECT key FROM key_value WHERE namespace = ?`).all?.(
      INCAPABLE_MODEL_NAMESPACE
    ) ?? []) as Array<{ key: string }>;
    for (const row of rows) if (row?.key) out.add(row.key);
  } catch {
    // Nothing learned yet.
  }
  return out;
}

/** Record that `provider/model` cannot serve a chat completion. */
export function recordModelIncapable(db: MinimalDb, modelStr: string, reason: string): void {
  if (!modelStr) return;
  try {
    db.prepare(
      `INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
    ).run?.(INCAPABLE_MODEL_NAMESPACE, modelStr, String(reason ?? "").slice(0, 300));
  } catch {
    // Learning is an optimisation; never fail a request because it could not be stored.
  }
}

/**
 * Does this 400 mean "this model can never chat", as opposed to "not this time"?
 *
 * Deliberately narrow. A 400 is usually the *caller's* fault, and marking a
 * healthy model permanently incapable because one malformed request was sent to
 * it would be exactly the headstone-writing mistake this codebase has already
 * paid for once. Only upstream phrasings that name the MODEL as the problem
 * qualify; a token-count refusal is explicitly excluded because it is handled by
 * the refusal-ceiling learner, which is size-aware and reversible.
 */
export function isModelIncapableRefusal(status: number, message: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const body = String(message ?? "").toLowerCase();
  if (!body) return false;
  // Size refusals belong to recordTokenRefusal(), not here.
  if (
    body.includes("too_many_tokens") ||
    body.includes("context length") ||
    body.includes("context window") ||
    body.includes("too long")
  ) {
    return false;
  }
  return (
    body.includes("invalid request: model") ||
    body.includes("is not supported") ||
    body.includes("model_not_found") ||
    body.includes("does not exist") ||
    body.includes("tool_use_not_supported")
  );
}
