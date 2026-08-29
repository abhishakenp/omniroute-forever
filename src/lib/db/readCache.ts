/**
 * DB Read Cache — In-memory TTL cache for hot read paths.
 *
 * SQLite reads are already fast since better-sqlite3 is synchronous and
 * memory-mapped. However, some functions (getSettings, getPricing,
 * getProviderConnections) are called on every request by multiple callers.
 * A short TTL cache (5s) eliminates redundant I/O without staling data for
 * long enough to matter (settings changes are applied within one cache cycle).
 *
 * Usage:
 *   import { dbCache } from '@/lib/db/readCache';
 *   const settings = await dbCache.getSettings();
 */

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize?: number) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize ?? 0;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict LRU (first key in insertion order) when at capacity
    if (this.maxSize > 0 && this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }
}

// Cache with 5s TTL — short enough to pick up dashboard changes quickly,
// long enough to serve burst request bursts without hammering SQLite.
const SETTINGS_TTL_MS = 5_000;
const PRICING_TTL_MS = 30_000;
const CONNECTIONS_TTL_MS = 5_000;
const SYNCED_MODELS_TTL_MS = 10_000; // 10s — model sync runs every 24h, 10s is safe
const settingsCache = new TTLCache<Record<string, unknown>>(SETTINGS_TTL_MS);
const pricingCache = new TTLCache<Record<string, unknown>>(PRICING_TTL_MS);
const connectionsCache = new TTLCache<unknown[]>(CONNECTIONS_TTL_MS, 500);
const syncedModelsByConnectionCache = new TTLCache<Record<string, unknown[]>>(
  SYNCED_MODELS_TTL_MS,
  50
);

/**
 * Cached wrapper for getSettings.
 * Invalidated on every updateSettings() call.
 */
export async function getCachedSettings(): Promise<Record<string, unknown>> {
  const cached = settingsCache.get("settings");
  if (cached) return cached;

  const { getSettings } = await import("@/lib/db/settings");
  const value = await getSettings();
  settingsCache.set("settings", value);
  return value;
}

/**
 * Cached wrapper for getPricing.
 * Longer TTL since pricing rarely changes mid-session.
 */
export async function getCachedPricing(): Promise<Record<string, unknown>> {
  const cached = pricingCache.get("pricing");
  if (cached) return cached as Record<string, unknown>;

  const { getPricing } = await import("@/lib/db/settings");
  const value = await getPricing();
  pricingCache.set("pricing", value);
  return value;
}
/**
 * Cached wrapper for getProviderConnections.
 * Used in request hot-paths (usageStats, callLogs, usageHistory, catalog, virtualFactory).
 * Now caches ALL query variants (filtered and unfiltered) for 5s.
 */
export async function getCachedProviderConnections(
  filter?: Record<string, unknown>
): Promise<unknown[]> {
  const cacheKey = filter && Object.keys(filter).length > 0 ? JSON.stringify(filter) : "all";

  const cached = connectionsCache.get(cacheKey);
  if (cached) return cached;

  const { getProviderConnections } = await import("@/lib/db/providers");
  const value = await getProviderConnections(filter);
  connectionsCache.set(cacheKey, value);
  return value;
}

const rawConnectionsCache = new TTLCache<unknown[]>(CONNECTIONS_TTL_MS, 500);

/**
 * Cached wrapper for getRawProviderConnections.
 * Same 5s TTL as the encrypted variant but preserves ciphertext fields
 * for lazy decryption — used by the auth selection hot path where 10k+
 * connections are filtered to find the winner but only 1 row needs
 * credential decryption.
 */
export async function getCachedRawProviderConnections(
  filter?: Record<string, unknown>
): Promise<unknown[]> {
  const key = JSON.stringify(filter ?? {});
  const cached = rawConnectionsCache.get(key);
  if (cached !== undefined) return cached;
  const { getRawProviderConnections } = await import("./providers");
  const rows = await getRawProviderConnections(filter);
  rawConnectionsCache.set(key, rows);
  return rows;
}

// Metadata-only columns for connection selection — excludes credential fields
// (api_key, access_token, refresh_token, id_token, expires_at, token_expires_at).
// The auth hot path loads hundreds of connections for filtering but only needs
// credentials for the single winner. This keeps credential data out of RAM
// during selection and scales to 10k+ connections without loading all secrets.
const CONNECTION_METADATA_COLUMNS = [
  "id", "provider", "auth_type", "name", "email", "priority", "is_active",
  "test_status", "error_code", "last_error", "last_error_at", "last_error_type",
  "last_error_source", "backoff_level", "rate_limited_until", "last_used_at",
  "consecutive_use_count", "max_concurrent", "default_model", "project_id",
  "display_name", "provider_specific_data", "quota_window_thresholds_json",
  "rate_limit_overrides_json",
];

const metadataConnectionsCache = new TTLCache<unknown[]>(CONNECTIONS_TTL_MS, 500);

/**
 * Cached metadata-only connection query for the auth selection hot path.
 * Loads all columns EXCEPT credentials (api_key, access_token, refresh_token,
 * id_token, expires_at, token_expires_at). The caller selects a winner from
 * metadata, then fetches credentials via getCachedRawProviderConnectionById.
 */
export async function getCachedProviderConnectionsMetadata(
  filter?: Record<string, unknown>
): Promise<unknown[]> {
  const key = JSON.stringify(filter ?? {});
  const cached = metadataConnectionsCache.get(key);
  if (cached !== undefined) return cached;
  const { getRawProviderConnections } = await import("./providers");
  const rows = await getRawProviderConnections(filter, undefined, undefined, CONNECTION_METADATA_COLUMNS);
  metadataConnectionsCache.set(key, rows);
  return rows;
}

/**
 * Fetch a single raw connection by ID (with credentials). Used after metadata-only
 * selection to load credentials for the winner. Cached with 5s TTL.
 */
export async function getCachedRawProviderConnectionById(
  id: string
): Promise<Record<string, unknown> | null> {
  const cached = connectionByIdCache.get(id);
  if (cached !== undefined) return cached;
  const { getRawProviderConnectionById } = await import("./providers");
  const row = await getRawProviderConnectionById(id);
  connectionByIdCache.set(id, row);
  return row;
}

const connectionByIdCache = new TTLCache<Record<string, unknown> | null>(
  CONNECTIONS_TTL_MS,
  10_000
);
const nodesCache = new TTLCache<(Record<string, unknown> | null)[]>(CONNECTIONS_TTL_MS);

/**
 * Cached wrapper for getProviderConnectionById.
 * Keyed by connection ID, shared 5s TTL.
 * Invalidated on every provider_connections write.
 */
export async function getCachedProviderConnectionById(
  id: string
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  const cached = connectionByIdCache.get(id);
  if (cached !== undefined) return cached;

  const { getProviderConnectionById } = await import("@/lib/db/providers");
  const value = await getProviderConnectionById(id);
  connectionByIdCache.set(id, value);
  return value;
}

/**
 * Cached wrapper for getProviderNodes.
 * Keyed by JSON-serialized filter, shared 5s TTL.
 * Invalidated on every provider_nodes write.
 */
export async function getCachedProviderNodes(
  filter?: Record<string, unknown>
): Promise<(Record<string, unknown> | null)[]> {
  const cacheKey = filter ? JSON.stringify(filter) : "all";
  const cached = nodesCache.get(cacheKey);
  if (cached) return cached;

  const { getProviderNodes } = await import("@/lib/db/providers");
  const value = await getProviderNodes(filter);
  nodesCache.set(cacheKey, value);
  return value;
}

// ──────────────── LKGP Cache Wrappers ────────────────

interface LKGPRecordCache {
  provider: string;
  connectionId?: string;
}

const lkgpCache = new TTLCache<LKGPRecordCache | null>(SETTINGS_TTL_MS);

/**
 * Cached wrapper for getSyncedAvailableModelsByConnection.
 * #1 CPU hot path: 86 OpenRouter connections × 426 models = 36,836
 * JSON.parse + normalize calls per request. With 10s TTL, burst chat requests
 * share one DB read + normalization pass instead of re-doing it per request.
 */
export async function getCachedSyncedAvailableModelsByConnection(
  providerId: string
): Promise<Record<string, unknown[]>> {
  const cacheKey = `syncedModels:${providerId}`;
  const cached = syncedModelsByConnectionCache.get(cacheKey);
  if (cached) return cached;

  const { getSyncedAvailableModelsByConnection } = await import("@/lib/db/models");
  const value = await getSyncedAvailableModelsByConnection(providerId);
  syncedModelsByConnectionCache.set(cacheKey, value);
  return value;
}

export async function getCachedLKGP(
  comboName: string,
  modelId: string
): Promise<LKGPRecordCache | null> {
  const cacheKey = `lkgp:${comboName}:${modelId}`;
  const cached = lkgpCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { getLKGP } = await import("@/lib/db/settings");
  const value = await getLKGP(comboName, modelId);
  lkgpCache.set(cacheKey, value);
  return value;
}

export async function setCachedLKGP(
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
): Promise<void> {
  const { setLKGP } = await import("@/lib/db/settings");
  await setLKGP(comboName, modelId, providerId, connectionId);
  lkgpCache.invalidate(`lkgp:${comboName}:${modelId}`);
}

// ──────────────── Combo Cache Invalidation Signal ────────────────
//
// The nested-combo expansion caches live in request handlers
// (`src/sse/handlers/chat.ts` getCombosCachedForChat and
// `open-sse/handlers/chatCore.ts` getCombosCached), each with a 10s TTL. A db
// module must NOT import a request handler (that would create an import cycle),
// so instead those caches consult this monotonically-incrementing version.
// Combo writes call `invalidateDbCache("combos")`, which bumps the version;
// the handlers compare the version they were populated at against the current
// one and treat a mismatch as a cache miss — so combo edits take effect
// immediately instead of after the 10s window (#3147).
let combosCacheVersion = 0;

/**
 * Current combo-cache version. Cache layers snapshot this when they populate
 * and re-read it on every access; a change means the underlying combos were
 * written and the cached expansion must be refreshed.
 */
export function getCombosCacheVersion(): number {
  return combosCacheVersion;
}

// ──────────────── Model Catalog Cache Invalidation Signal ────────────────
//
// #6408 added a request-shape-keyed (prefix/isCodex/apiKey) TTL cache around the
// unified /v1/models builder (src/app/api/v1/models/catalog.ts) to coalesce
// concurrent/bursty GETs. That cache key does not vary with the underlying DB
// state the builder reads (connections, settings, combos), so a write followed by
// a read within the ~1.5s TTL replayed the pre-write response. Same import-cycle
// constraint as combosCacheVersion above (a db module must not import the route
// module) — catalog.ts instead compares this version on every access and drops its
// whole cache the moment it moves, so any write that calls invalidateDbCache() makes
// the next read miss immediately instead of waiting out the TTL.
let modelCatalogCacheVersion = 0;

/**
 * Current model-catalog-cache version. `getUnifiedModelsResponse()` folds this
 * into its response cache key; a change means settings/connections/combos were
 * written since the cache was populated and the cached body is stale.
 */
export function getModelCatalogCacheVersion(): number {
  return modelCatalogCacheVersion;
}

/**
 * Invalidate caches (call after writes to any of: settings, pricing,
 * connections, combos, nodes).
 *
 * When scope is `"connections"` and an `id` is provided, only that
 * connection's by-ID cache entry is invalidated (the filter-keyed raw
 * cache must still be fully cleared since overlapping filter results
 * cannot be selectively invalidated).
 */
export function invalidateDbCache(
  scope?:
    | "settings"
    | "pricing"
    | "connections"
    | "combos"
    | "nodes"
    | "model-capabilities"
    | "synced-models",
  id?: string
): void {
  if (!scope || scope === "settings") settingsCache.invalidate();
  if (!scope || scope === "pricing") pricingCache.invalidate();
  if (!scope || scope === "connections") {
    connectionsCache.invalidate();
    rawConnectionsCache.invalidate();
    if (id) {
      connectionByIdCache.invalidate(id);
    } else {
      connectionByIdCache.invalidate();
    }
  }
  if (!scope || scope === "nodes") nodesCache.invalidate();
  if (!scope || scope === "combos") combosCacheVersion++;
  if (!scope || scope === "synced-models") syncedModelsByConnectionCache.invalidate();
  // Settings/connections/combos all feed the unified model catalog builder
  // (blockedProviders + hidePaidModels, provider connections + excludedModels,
  // combo definitions, respectively) — pricing does too, via isFreeModel().
  modelCatalogCacheVersion++;
}
