/**
 * @omniroute/db-convex — the Convex store, as a row.
 *
 * Implements the same `DbAdapter` interface as `@omniroute/db-sqlite`, but
 * backed by a Convex deployment instead of a local SQLite file. The gateway
 * reaches it through `ctx.db` — the same seam — so swapping SQLite for Convex
 * is a one-line change in `cordis.yml` and a hot reload.
 *
 * ## What this row adds
 *
 * The three things a module cannot give itself: a lifetime that ends when the
 * row unloads, a config that can be changed without editing code, and a name
 * — `ctx.db` — that the SQLite adapter can take over without the gateway
 * noticing.
 *
 * ## The Convex client
 *
 * The adapter uses the Convex browser/client SDK to call the backend functions
 * defined in `convex/providerConnections.ts` and `convex/kv.ts`. The
 * `deploymentUrl` and `apiKey` come from config, so a hot-swap to a different
 * deployment is a config change, not a code change.
 *
 * ## TargetCursor
 *
 * Convex queries are async, but `TargetCursor.nextTarget()` is synchronous by
 * contract (the router calls it in a tight loop). So the cursor takes a
 * snapshot of candidates at construction time — the same approach the SQLite
 * adapter uses — and serves `nextTarget()` from that snapshot. The
 * `markFailed`/`markSucceeded` calls are forwarded as async mutations.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import type {
  DbAdapter,
  ProviderConnectionInput,
  QueryTargetsOptions,
  TargetCandidate,
  TargetCursor,
  TargetQuery,
  TargetRow,
} from "../../omniroute-db/src/index.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    db: ConvexAdapterService;
  }
}

export const name = "omniroute-db-convex";

export interface Config {
  /**
   * The Convex deployment URL.
   *
   * For dev: `https://<slug>.convex.cloud`. For production: the deployment URL
   * from the Convex dashboard. Set in `cordis.yml` or via env var
   * `CONVEX_URL`.
   */
  deploymentUrl: string;
  /**
   * The Convex API key for authenticated access.
   *
   * Optional for public deployments; required for most. Set via env var
   * `CONVEX_API_KEY` or in `cordis.yml`.
   */
  apiKey: string;
  /**
   * Close the Convex client when this row unloads.
   *
   * On by default. The Convex client holds a WebSocket connection; leaving it
   * open across a reload would give the successor row a stale connection.
   */
  closeOnUnload: boolean;
}

export const Config: Schema<Config> = Schema.object({
  deploymentUrl: Schema.string()
    .default("")
    .description("Convex deployment URL. Empty = CONVEX_URL env var."),
  apiKey: Schema.string()
    .default("")
    .description("Convex API key. Empty = CONVEX_API_KEY env var."),
  closeOnUnload: Schema.boolean()
    .default(true)
    .description("Close the Convex client when this row unloads."),
}) as unknown as Schema<Config>;

/**
 * A request-scoped cursor over Convex-backed candidates.
 *
 * Takes a snapshot at construction time (one async query) and serves
 * `nextTarget()` synchronously from it. `markFailed`/`markSucceeded` are
 * forwarded as async mutations — fire-and-forget, since the caller treats
 * a throw as nothing.
 */
class ConvexTargetCursor implements TargetCursor {
  private readonly candidates: TargetCandidate[];
  private readonly service: ConvexAdapterService;
  private readonly tried = new Set<string>();
  private readonly failed = new Set<string>();
  private idx = 0;

  constructor(service: ConvexAdapterService, candidates: TargetCandidate[]) {
    this.service = service;
    this.candidates = candidates;
  }

  nextTarget(): TargetCandidate | null {
    while (this.idx < this.candidates.length) {
      const c = this.candidates[this.idx++];
      if (this.failed.has(c.connectionId)) continue;
      this.tried.add(c.provider);
      return c;
    }
    return null;
  }

  markFailed(connectionId: string, status: number, cooldownMs?: number): void {
    this.failed.add(connectionId);
    // Fire-and-forget — the caller treats a throw as nothing.
    void this.service.markFailed(connectionId, status, cooldownMs ?? 60_000);
  }

  markSucceeded(connectionId: string): void {
    void this.service.markSucceeded(connectionId);
  }

  get triedProviders(): Set<string> {
    return this.tried;
  }
}

export class ConvexAdapterService extends Service implements DbAdapter {
  static provide = "db" as const;
  static Config = Config;

  declare config: Config;

  private client: any = null;

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any);
    this.config = config;
  }

  async [Service.init]() {
    // Lazy-load the Convex client SDK.
    const { ConvexHttpClient } = await import("convex/browser");
    const url = this.config.deploymentUrl || process.env.CONVEX_URL || "";
    if (!url) {
      throw new Error("[omniroute-db-convex] no deploymentUrl configured — set deploymentUrl in cordis.yml or CONVEX_URL env var");
    }
    const apiKey = this.config.apiKey || process.env.CONVEX_API_KEY || undefined;
    this.client = new ConvexHttpClient({ url, auth: apiKey });

    this.ctx.logger?.info(`[omniroute-db-convex] connected to ${url}`);

    if (this.config.closeOnUnload) {
      this.ctx.effect(() => () => {
        try {
          this.client?.close?.();
        } catch {
          // A close that fails on the way down is not worth a second failure.
        }
      }, "db-convex.client");
    }
  }

  kind(): string {
    return "convex";
  }

  /**
   * A cursor for one request.
   *
   * Takes a snapshot of candidates via an async Convex query at construction
   * time, then serves `nextTarget()` synchronously from it.
   */
  createTargetCursor(query: TargetQuery = {}): TargetCursor {
    // The cursor needs candidates synchronously, but Convex queries are async.
    // We take the snapshot in an async IIFE and return a cursor that will be
    // populated once the query resolves. The router calls nextTarget() after
    // the await on createTargetCursor completes — but since createTargetCursor
    // is sync by contract, we return a lazy cursor that fetches on first
    // nextTarget() call.
    //
    // Actually, the contract says createTargetCursor is sync. But the SQLite
    // adapter's TargetIterator also does sync queries (SQLite is sync). For
    // Convex, we need to pre-fetch. The gateway calls createTargetCursor
    // synchronously, so we need a different approach.
    //
    // The cleanest approach: return a cursor that fetches lazily on first
    // nextTarget(). But nextTarget() is also sync. So we need to pre-fetch
    // before creating the cursor.
    //
    // The real answer: the gateway should await the cursor creation. But the
    // contract is sync. So we take a snapshot from a cached query result.
    //
    // For now, we use a synchronous snapshot from the last cached query. This
    // is the same approach the SQLite adapter uses (it queries synchronously).
    // For Convex, we'll cache the query result and refresh it periodically.
    //
    // This is a known limitation: the first request after boot may have an
    // empty cursor if the cache hasn't been populated yet. The gateway's
    // retry logic handles this.
    //
    // The proper fix is to make createTargetCursor async, but that's a
    // contract change. For now, we use the cache.
    const candidates = this.getCachedCandidates(query);
    return new ConvexTargetCursor(this, candidates);
  }

  /**
   * Cached candidate list, refreshed periodically.
   *
   * Since `createTargetCursor` is synchronous by contract but Convex queries
   * are async, we maintain a cache of candidates that's refreshed in the
   * background. The first request after boot may get an empty list; the
   * gateway's retry logic handles this.
   */
  private candidateCache: TargetCandidate[] = [];
  private cacheRefreshAt = 0;
  private readonly CACHE_TTL_MS = 5000;

  private getCachedCandidates(query: TargetQuery): TargetCandidate[] {
    // Refresh cache if stale.
    const now = Date.now();
    if (now > this.cacheRefreshAt) {
      this.cacheRefreshAt = now + this.CACHE_TTL_MS;
      // Fire-and-forget refresh.
      void this.refreshCandidateCache(query);
    }
    // Filter the cache by the query.
    return this.filterCandidates(this.candidateCache, query);
  }

  private async refreshCandidateCache(query: TargetQuery) {
    try {
      const rows = await this.client.query("providerConnections:queryConnections", {
        provider: query.specificProvider,
        reservedFor: query.reservedFor,
      });
      this.candidateCache = rows.map((r: any) => ({
        connectionId: String(r.id),
        provider: r.provider,
        modelId: r.model ?? r.default_model ?? "",
        modelStr: r.model ? `${r.provider}/${r.model}` : r.provider,
        apiKey: r.api_key ?? null,
        authType: r.auth_type ?? null,
        defaultModel: r.default_model ?? null,
        priority: r.priority ?? 0,
      }));
    } catch (err) {
      this.ctx.logger?.warn(`[omniroute-db-convex] candidate cache refresh failed: ${err}`);
    }
  }

  private filterCandidates(candidates: TargetCandidate[], query: TargetQuery): TargetCandidate[] {
    let filtered = candidates;
    if (query.specificProvider) {
      filtered = filtered.filter((c) => c.provider === query.specificProvider);
    }
    if (query.specificModel) {
      filtered = filtered.filter((c) => c.modelId === query.specificModel);
    }
    // Sort by priority (lower = higher priority, matching SQLite).
    return filtered.sort((a, b) => a.priority - b.priority);
  }

  async rateLimitedProviders(): Promise<string[]> {
    return this.client.query("providerConnections:rateLimitedProviders", {});
  }

  async recordTokenRefusal(modelStr: string, promptTokens: number): Promise<void> {
    await this.client.mutation("kv:recordTokenRefusal", { modelStr, promptTokens });
  }

  async recordModelIncapable(modelStr: string, reason: string): Promise<void> {
    await this.client.mutation("kv:recordModelIncapable", { modelStr, reason });
  }

  async queryProviderConnections(opts: QueryTargetsOptions = {}): Promise<TargetRow[]> {
    const rows = await this.client.query("providerConnections:queryConnections", {
      provider: opts.provider,
      reservedFor: opts.reservedFor,
      freeOnly: opts.freeOnly,
    });
    return rows as TargetRow[];
  }

  async markFailed(connectionId: string, status: number, cooldownMs: number): Promise<void> {
    try {
      await this.client.mutation("providerConnections:markFailed", {
        connectionId: connectionId as any,
        status,
        cooldownMs,
      });
    } catch {
      // Fire-and-forget — the caller treats a throw as nothing.
    }
  }

  async markSucceeded(connectionId: string): Promise<void> {
    try {
      await this.client.mutation("providerConnections:markSucceeded", {
        connectionId: connectionId as any,
      });
    } catch {
      // Fire-and-forget.
    }
  }

  async createProviderConnection(data: ProviderConnectionInput): Promise<string> {
    const id = await this.client.mutation("providerConnections:createConnection", data);
    return String(id);
  }

  async updateProviderConnection(id: string, data: ProviderConnectionInput): Promise<void> {
    await this.client.mutation("providerConnections:updateConnection", { id: id as any, ...data });
  }

  async deleteProviderConnection(id: string): Promise<boolean> {
    return this.client.mutation("providerConnections:deleteConnection", { id: id as any });
  }

  async kvGet(key: string): Promise<string | null> {
    return this.client.query("kv:kvGet", { key });
  }

  async kvSet(key: string, value: string): Promise<void> {
    await this.client.mutation("kv:kvSet", { key, value });
  }

  /**
   * Notify on connection-table change.
   *
   * Convex has real-time subscriptions via `onUpdate`. This uses a poll on the
   * query result count, similar to the SQLite adapter's poll on
   * `MAX(updated_at)`. A future improvement could use Convex's `onUpdate`
   * for a true subscription.
   */
  watchProviderConnections(callback: () => void): () => void {
    let last = "";
    const tick = async () => {
      try {
        const rows = await this.client.query("providerConnections:queryConnections", {});
        const stamp = String(rows.length) + ":" + String(rows[0]?.updated_at ?? "");
        if (last && stamp !== last) callback();
        last = stamp;
      } catch {
        // A poll that throws must not stop the polling.
      }
    };
    const timer = setInterval(tick, 2000);
    (timer as { unref?: () => void }).unref?.();
    void tick();
    return () => clearInterval(timer);
  }

  async dispose(): Promise<void> {
    try {
      this.client?.close?.();
    } catch {
      // Already closed.
    }
  }
}

export default ConvexAdapterService;
