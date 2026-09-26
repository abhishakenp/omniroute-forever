import { getDbInstance } from "@/lib/db/core.ts";
import { getProviderRegistry } from "@omniroute/open-sse/services/autoCombo/providerRegistryAccessor.ts";

/**
 * `/v1/models` — the model catalogue served by the headless Bun gateway.
 *
 * ## What was wrong
 *
 * This handler rebuilt the entire catalogue on **every single request**: one
 * query for the active providers, then per provider a `key_value` lookup and a
 * `JSON.parse` of its whole synced-model blob, then ~1,400 object literals, then
 * a `JSON.stringify` of the ~150 KB result. Nothing was memoised. (It is not
 * served by `catalogCache.ts` either — that cache sits in front of `/v1`,
 * `/v1/models/[...model]` and `/v1/providers/[provider]/models`, and this route
 * never consults it.)
 *
 * Two further defects came from the same code:
 *
 *  - `created: Date.now()` was evaluated per model per request, so **the response
 *    body differed on every request** even when the catalogue was identical.
 *    That defeats ETag/conditional requests and any downstream cache.
 *  - Synced models and registry models were both appended, so a provider present
 *    in both emitted **duplicate ids**.
 *
 * ## What it does now
 *
 * Serve a **pre-serialised** buffer and rebuild only when the catalogue would
 * actually differ. Invalidation is driven by a *signature* of the exact inputs
 * this route reads — the set of active provider ids, and the key/length of each
 * `syncedAvailableModels` row — rather than by any connection write. That
 * distinction is the point: `rate_limited_until` being stamped on a connection
 * hundreds of times an hour does not change which models exist, and under the
 * old global cache-version bump it invalidated everything anyway.
 *
 * The signature is two cheap aggregate queries. A `TTL` backstop bounds the one
 * residual risk (an in-place edit of a synced blob that preserves its exact byte
 * length and key set), so even that converges within a minute.
 */

/** Signature recheck is cheap, but rebuild at least this often regardless. */
const CATALOG_MAX_AGE_MS = 60_000;

interface CachedCatalog {
  signature: string;
  /** Pre-serialised body — no re-stringify on a hit. */
  body: string;
  etag: string;
  builtAt: number;
}

let cached: CachedCatalog | null = null;

/**
 * A cheap fingerprint of exactly the inputs this route reads.
 *
 * Deliberately NOT a hash of the full model blobs: that would cost as much as
 * rebuilding. `key || ':' || length(value)` over ~20 rows plus the active
 * provider list detects every realistic change (a model added, removed, renamed,
 * a provider activated or deactivated) for two indexed aggregate queries.
 */
function catalogSignature(db: ReturnType<typeof getDbInstance>): string {
  const providers = db
    .prepare(
      `SELECT DISTINCT provider FROM provider_connections WHERE is_active = 1 ORDER BY provider`
    )
    .all() as Array<{ provider: string }>;
  const synced = db
    .prepare(
      `SELECT key, LENGTH(value) AS len FROM key_value
       WHERE namespace = 'syncedAvailableModels' ORDER BY key`
    )
    .all() as Array<{ key: string; len: number }>;
  return (
    providers.map((p) => p.provider).join(",") +
    "|" +
    synced.map((r) => `${r.key}:${r.len}`).join(",")
  );
}

interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

function buildCatalogBody(db: ReturnType<typeof getDbInstance>): string {
  const registry = getProviderRegistry();
  const models: ModelEntry[] = [];
  // One timestamp for the whole build, not one per model. `created` is a
  // property of the catalogue, so a stable value is both more correct and what
  // makes the body byte-identical across requests.
  const created = Math.floor(Date.now() / 1000);
  // Ids are unique in an OpenAI model list; the old code could emit a provider's
  // model twice when it had both synced and registry entries.
  const seen = new Set<string>();

  const push = (id: string, owned_by: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    models.push({ id, object: "model", created, owned_by });
  };

  for (const id of [
    "auto/best-free",
    "auto/best-coding",
    "auto/best-reasoning",
    "auto/best-fast",
    "auto/best-chat",
  ]) {
    push(id, "omniroute");
  }

  const connections = db
    .prepare(`SELECT DISTINCT provider FROM provider_connections WHERE is_active = 1`)
    .all() as Array<{ provider: string }>;

  for (const { provider } of connections) {
    const modelRows = db
      .prepare(
        `SELECT value FROM key_value
         WHERE namespace = 'syncedAvailableModels'
           AND (key = ? OR key LIKE ?)
         LIMIT 1`
      )
      .get(provider, `${provider}:%`) as { value: string } | undefined;

    if (modelRows?.value) {
      try {
        const parsed = JSON.parse(modelRows.value);
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (typeof m?.id === "string") push(`${provider}/${m.id}`, provider);
          }
        }
      } catch {
        // A corrupt blob must not take the whole catalogue down.
      }
    }

    const entry = registry[provider];
    if (entry?.models && Array.isArray(entry.models)) {
      for (const m of entry.models) {
        if (typeof m?.id === "string") push(`${provider}/${m.id}`, provider);
      }
    }
  }

  return JSON.stringify({ object: "list", data: models });
}

/** FNV-1a. Local so the route works under both Bun and Node (tests run on both). */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Exposed for tests: drop the memoised catalogue. */
export function __resetModelCatalogCache(): void {
  cached = null;
}

/** Exposed for tests: how many full rebuilds have happened. */
let rebuildCount = 0;
export function __modelCatalogRebuildCount(): number {
  return rebuildCount;
}

function getCatalog(): CachedCatalog {
  const db = getDbInstance();
  const signature = catalogSignature(db);
  const now = Date.now();
  if (cached && cached.signature === signature && now - cached.builtAt < CATALOG_MAX_AGE_MS) {
    return cached;
  }
  const body = buildCatalogBody(db);
  rebuildCount++;
  // A weak ETag over length+signature is enough to detect a changed catalogue
  // and costs nothing; the body is already known to be stable for a signature.
  cached = {
    signature,
    body,
    etag: `W/"${body.length.toString(16)}-${fnv1a(signature).toString(16)}"`,
    builtAt: now,
  };
  return cached;
}

export async function GET(request?: Request) {
  const catalog = getCatalog();

  // The body is now byte-stable for a given catalogue, so conditional requests
  // finally work: a repeat caller gets 304 and 0 bytes instead of 150 KB.
  const inm = request?.headers?.get?.("if-none-match");
  if (inm && inm === catalog.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: catalog.etag, "Cache-Control": "no-cache" },
    });
  }

  return new Response(catalog.body, {
    headers: {
      "Content-Type": "application/json",
      ETag: catalog.etag,
      "Cache-Control": "no-cache",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function HEAD() {
  return new Response(null, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
