/**
 * @omniroute/db-sqlite — the SQLite store, as a row.
 *
 * ## Why this file imports rather than contains
 *
 * `core.ts`, `targetIterator.ts`, `providers.ts` and the 138 migrations beside
 * them are the store. They are ~4,000 lines that a live gateway has been
 * exercising against 718 real connection rows, and every one of their comments
 * is a scar. Copying them in here would produce a second copy that starts
 * identical and ends different, and the first symptom of the drift would be a
 * routing decision nobody could reproduce.
 *
 * So this row imports them. What it adds is the three things a module cannot
 * give itself: a lifetime that ends when the row unloads, a config that can be
 * changed without editing code, and a name — `ctx.db` — that a Convex adapter
 * can take over without the gateway noticing.
 *
 * ## Why the imports are dynamic
 *
 * `core.ts` resolves `DATA_DIR` at module-evaluation time (`core.ts:90`), and
 * `SQLITE_FILE` from it one line later. An ESM `import` is hoisted above every
 * statement in this file, so a static import would fix the data directory
 * before this row's own config had been read — making `dataDir` a setting that
 * silently did nothing. Loading them inside `Service.init`, after the config is
 * in hand, is what makes the setting real. It also means the store opens when
 * the row loads and not when the file is first parsed.
 *
 * Everything downstream (`thinGateway.ts` and friends) may still import those
 * modules statically: by the time the gateway row is applied, this row has
 * already put them in the module cache with the right `DATA_DIR`.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import type {
  DbAdapter,
  ProviderConnectionInput,
  QueryTargetsOptions,
  TargetCursor,
  TargetQuery,
  TargetRow as SeamRow,
} from '../../omniroute-db/src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    db: SqliteAdapterService
  }
}

export const name = 'omniroute-db-sqlite'

export interface Config {
  /**
   * Where `storage.sqlite`, `.env` and `db_backups/` live.
   *
   * Empty means "whatever `DATA_DIR` already says, else `~/.omniroute`" — the
   * production answer. Setting it is how a second instance is pointed at a copy
   * instead of at the 38 MB the live gateway is writing to.
   */
  dataDir: string
  /** Load `<dataDir>/.env` into the process env before opening the store. */
  loadDotEnv: boolean
  /** Register the local-CLI passthrough connections (auggie, …) at boot. */
  seedLocalCli: boolean
  /**
   * Close the database when this row unloads.
   *
   * On by default, unlike `@iris/persist`'s equivalent, and for the opposite
   * reason: a SQLite handle is exclusive-ish and holds a WAL. Leaving it open
   * across a reload would give the successor row a second handle onto the same
   * file rather than an inherited one.
   */
  closeOnUnload: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string()
    .default('')
    .description('Directory holding storage.sqlite. Empty = DATA_DIR env, else ~/.omniroute.'),
  loadDotEnv: Schema.boolean()
    .default(true)
    .description('Read <dataDir>/.env into process.env before opening the store.'),
  seedLocalCli: Schema.boolean()
    .default(true)
    .description('Seed local-CLI passthrough connections at boot so failover can quarantine them.'),
  closeOnUnload: Schema.boolean()
    .default(true)
    .description('Close the SQLite handle when this row unloads.'),
}) as unknown as Schema<Config>

/** The live-path modules, once loaded. Shape mirrors the files they come from. */
export interface StoreModules {
  core: typeof import('../../../src/lib/db/core.ts')
  providers: typeof import('../../../src/lib/db/providers.ts')
  targets: typeof import('../../../src/lib/db/targetIterator.ts')
  keyless: typeof import('../../../src/lib/db/keylessHealth.ts')
  fitness: typeof import('../../../src/lib/db/modelFitness.ts')
}

export class SqliteAdapterService extends Service implements DbAdapter {
  static provide = 'db' as const
  static Config = Config

  declare config: Config

  private modules: StoreModules | null = null
  /**
   * One iterator kept only for `markFailed` / `markSucceeded`.
   *
   * Those two methods are pure writes against `provider_connections` plus a
   * keyless-health map; they never read the tried-set that makes an iterator
   * request-scoped. Constructing a fresh one per mark would re-run three
   * snapshot queries for nothing.
   */
  private marker: { markFailed(id: string, status: number, cooldownMs?: number): void; markSucceeded(id: string): void } | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    if (this.config.dataDir) process.env.DATA_DIR = this.config.dataDir
    if (this.config.loadDotEnv) this.loadDotEnv()

    const [core, providers, targets, keyless, fitness] = await Promise.all([
      import('../../../src/lib/db/core.ts'),
      import('../../../src/lib/db/providers.ts'),
      import('../../../src/lib/db/targetIterator.ts'),
      import('../../../src/lib/db/keylessHealth.ts'),
      import('../../../src/lib/db/modelFitness.ts'),
    ])
    this.modules = { core, providers, targets, keyless, fitness } as StoreModules

    // Opens the file, runs every pending migration, heals missing columns.
    await core.ensureDbInitialized()
    core.getDbInstance()

    if (this.config.seedLocalCli) {
      try {
        const { seedLocalCliConnections } = await import('../../../src/lib/db/seedLocalCliConnections.ts')
        seedLocalCliConnections()
      } catch (err) {
        // Seeding is a convenience; a gateway that cannot seed still routes.
        console.warn('[omniroute-db-sqlite] local-CLI seeding failed:', err)
      }
    }

    this.marker = new targets.TargetIterator({})

    if (this.config.closeOnUnload) {
      this.ctx.effect(() => () => {
        try {
          core.closeDbInstance()
        } catch {
          // A close that fails on the way down is not worth a second failure.
        }
      }, 'db-sqlite.handle')
    }
  }

  /** `<dataDir>/.env` into `process.env`, never overwriting what is already set. */
  private loadDotEnv() {
    const dir = this.config.dataDir || process.env.DATA_DIR || `${process.env.HOME ?? ''}/.omniroute`
    try {
      const path = `${dir}/.env`
      if (!existsSync(path)) return
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
      }
    } catch (err) {
      console.warn('[omniroute-db-sqlite] .env load failed:', err)
    }
  }

  private need(): StoreModules {
    if (!this.modules) throw new Error('[omniroute-db-sqlite] store used before init')
    return this.modules
  }

  /** The raw handle, for the live-path modules that take a `db` argument. */
  handle() {
    return this.need().core.getDbInstance()
  }

  /** Where the store actually opened. Worth printing at boot. */
  location(): string | null {
    return this.need().core.SQLITE_FILE
  }

  /** A fresh request-scoped iterator. One per request — the tried-set is state. */
  iterator(opts: ConstructorParameters<StoreModules['targets']['TargetIterator']>[0] = {}) {
    return new (this.need().targets.TargetIterator)(opts)
  }

  // ── DbAdapter ─────────────────────────────────────────────────────────────

  kind(): string {
    return "sqlite";
  }

  /**
   * A cursor for one request.
   *
   * `TargetIterator` already *is* a `TargetCursor` — same three methods, same
   * `triedProviders` getter — so this is a rename, not an adapter. That is the
   * point: the router used to construct that class by name, and the only thing
   * wrong with doing so was the name. Nothing about the behaviour changes here,
   * so nothing about routing changes when the gateway starts asking through the
   * seam instead of reaching past it.
   */
  createTargetCursor(query: TargetQuery = {}): TargetCursor {
    return new (this.need().targets.TargetIterator)(query) as unknown as TargetCursor;
  }

  /**
   * Providers holding an active credential that is currently rate limited.
   *
   * This is the raw `getDbInstance().prepare(...)` that lived inline in
   * `thinGateway.ts`, moved behind the seam unchanged. It stays a single
   * DISTINCT query rather than a filter over `queryProviderConnections()`
   * because the answer is a handful of provider names out of 718 rows, and
   * lifting all 718 across the seam to count them would make the exhaustion
   * path — already the slowest path there is — slower still.
   */
  async rateLimitedProviders(): Promise<string[]> {
    const rows = this.handle()
      .prepare(
        `SELECT DISTINCT provider FROM provider_connections
         WHERE is_active = 1 AND rate_limited_until IS NOT NULL`,
      )
      .all() as Array<{ provider?: string }>;
    return rows.map((r) => String(r.provider ?? "")).filter(Boolean);
  }

  /** Both `record*` calls are optimisations; the callers already treat a throw as nothing. */
  async recordTokenRefusal(modelStr: string, promptTokens: number): Promise<void> {
    this.need().targets.recordTokenRefusal(this.handle(), modelStr, promptTokens);
  }

  async recordModelIncapable(modelStr: string, reason: string): Promise<void> {
    this.need().keyless.recordModelIncapable(this.handle(), modelStr, reason);
  }

  async queryProviderConnections(opts: QueryTargetsOptions = {}): Promise<SeamRow[]> {
    const rows = (await this.need().providers.getRawProviderConnections(
      opts.provider ? { provider: opts.provider } : {},
    )) as unknown as SeamRow[]
    if (!opts.reservedFor) return rows.filter((r) => r.reserved_for == null)
    return rows.filter((r) => r.reserved_for == null || r.reserved_for === opts.reservedFor)
  }

  async markFailed(connectionId: string, status: number, cooldownMs: number): Promise<void> {
    this.marker?.markFailed(connectionId, status, cooldownMs)
  }

  async markSucceeded(connectionId: string): Promise<void> {
    this.marker?.markSucceeded(connectionId)
  }

  async createProviderConnection(data: ProviderConnectionInput): Promise<string> {
    const row = (await this.need().providers.createProviderConnection(data)) as { id?: string } | null
    return String(row?.id ?? '')
  }

  async updateProviderConnection(id: string, data: ProviderConnectionInput): Promise<void> {
    await this.need().providers.updateProviderConnection(id, data)
  }

  async deleteProviderConnection(id: string): Promise<boolean> {
    const { deleteProviderConnection } = await import('../../../src/lib/db/providers/deletion.ts')
    return Boolean(await deleteProviderConnection(id))
  }

  async kvGet(key: string): Promise<string | null> {
    const row = this.handle()
      .prepare(`SELECT value FROM key_value WHERE key = ?`)
      .get(key) as { value?: string } | undefined
    return row?.value ?? null
  }

  async kvSet(key: string, value: string): Promise<void> {
    this.handle()
      .prepare(
        `INSERT INTO key_value (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /**
   * Notify on connection-table change.
   *
   * SQLite has no change feed this process can subscribe to across handles, and
   * the live path never needed one — the iterator re-queries per request. So
   * this is a poll on `MAX(updated_at)`, and it is honest about being one: a
   * Convex adapter will replace it with a real subscription and the caller will
   * not change.
   */
  watchProviderConnections(callback: () => void): () => void {
    let last = ''
    const tick = () => {
      try {
        const row = this.handle()
          .prepare(`SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') AS stamp FROM provider_connections`)
          .get() as { stamp?: string } | undefined
        const stamp = row?.stamp ?? ''
        if (last && stamp !== last) callback()
        last = stamp
      } catch {
        // A poll that throws must not stop the polling.
      }
    }
    const timer = setInterval(tick, 2000)
    ;(timer as { unref?: () => void }).unref?.()
    tick()
    return () => clearInterval(timer)
  }

  async dispose(): Promise<void> {
    this.need().core.closeDbInstance()
  }
}

export default SqliteAdapterService
