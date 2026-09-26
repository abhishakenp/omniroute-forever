/**
 * @omniroute/db-memory — a store with no database.
 *
 * ## Why this row exists
 *
 * A seam that has exactly one implementation is not a seam; it is an interface
 * nobody has ever tested against a second thing, and the first time someone
 * tries — a Convex adapter, Scope 9 — they discover which parts of the contract
 * were secretly SQLite's. This row is the second thing, and it is deliberately
 * the *smallest* second thing: a handful of rows held in a `Map`, no I/O, no
 * schema, no migrations.
 *
 * It is not a fixture. `@omniroute/db-sqlite` and this row are both `ctx.db`,
 * so swapping the composition from one to the other is a real hot-swap through
 * the real loader, and the difference shows up in `/health` (`store`) and in
 * which candidates the router is offered. That is the demonstration Scope 8
 * asks for, and it could not be made with a mock inside a test file.
 *
 * ## What it deliberately does not do
 *
 * It does not reach an upstream. Its connections carry a fake provider name and
 * a fake key, so a chat completion routed through it *will* fail — and the
 * failure names `memory/…` in the error list, which is precisely how one can
 * tell from outside that the swap took. Making it succeed would mean giving it
 * a real credential, and a store whose whole purpose is to be obviously not the
 * real one has no business holding one.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  DbAdapter,
  ProviderConnectionInput,
  QueryTargetsOptions,
  TargetCandidate,
  TargetCursor,
  TargetQuery,
  TargetRow,
} from '../../omniroute-db/src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    db: MemoryAdapterService
  }
}

export const name = 'omniroute-db-memory'

export interface Config {
  /**
   * The fake connections this store offers, as `provider/model` strings.
   *
   * Defaulted rather than required, because the point of the row is to be
   * mountable with `name:` and nothing else. The names are conspicuous on
   * purpose: if one of these ever appears in a production error list, the
   * composition is wrong and the string says so.
   */
  targets: string[]
  /** Reserve every fake connection for this consumer tag. Empty = general pool. */
  reservedFor: string
}

export const Config: Schema<Config> = Schema.object({
  targets: Schema.array(Schema.string())
    .default(['memory/fake-alpha', 'memory/fake-beta'])
    .description('provider/model pairs this store offers. Fake by design — none of them reach an upstream.'),
  reservedFor: Schema.string()
    .default('')
    .description('Consumer tag every fake row is reserved for. Empty means the general pool.'),
}) as unknown as Schema<Config>

interface MemoryRow {
  id: string
  provider: string
  modelId: string
  apiKey: string | null
  reserved_for: string | null
  is_active: number
  rate_limited_until: number | null
  /** Set when `markFailed` fires; the cursor skips a row in cooldown. */
  cooldownUntil: number
}

/**
 * The cursor.
 *
 * Same three methods and same `triedProviders` getter as `TargetIterator`,
 * because that is the contract — but the resemblance stops there. This one has
 * no snapshot queries to run and no backoff ladder: a failure is a timestamp,
 * and it is enough to make the second attempt in a request pick something else,
 * which is the only behaviour the router actually depends on.
 */
class MemoryCursor implements TargetCursor {
  private readonly tried = new Set<string>()
  private readonly providers = new Set<string>()

  constructor(
    private readonly rows: MemoryRow[],
    private readonly query: TargetQuery,
    private readonly now: () => number,
  ) {}

  nextTarget(): TargetCandidate | null {
    const wanted = this.query.reservedFor
    for (const row of this.rows) {
      if (this.tried.has(row.id)) continue
      if (!row.is_active) continue
      if (row.cooldownUntil > this.now()) continue
      // The reserved invariant, restated rather than inherited: a key set aside
      // for one consumer must never be spent by anyone else. An adapter that
      // forgot this clause would leak reserved credentials and nothing in the
      // router would notice, so every adapter has to carry it.
      if (row.reserved_for) {
        if (row.reserved_for !== wanted) continue
      }
      if (this.query.specificProvider && row.provider !== this.query.specificProvider) continue
      if (this.query.specificModel && row.modelId !== this.query.specificModel) continue
      this.tried.add(row.id)
      this.providers.add(row.provider)
      return {
        connectionId: row.id,
        provider: row.provider,
        modelId: row.modelId,
        modelStr: `${row.provider}/${row.modelId}`,
        apiKey: row.apiKey,
        authType: 'api_key',
        defaultModel: row.modelId,
        priority: 0,
      }
    }
    return null
  }

  markFailed(connectionId: string, _status: number, cooldownMs = 60_000): void {
    const row = this.rows.find((r) => r.id === connectionId)
    if (row) row.cooldownUntil = this.now() + cooldownMs
  }

  markSucceeded(connectionId: string): void {
    const row = this.rows.find((r) => r.id === connectionId)
    if (row) row.cooldownUntil = 0
  }

  get triedProviders(): Set<string> {
    return new Set(this.providers)
  }
}

export class MemoryAdapterService extends Service implements DbAdapter {
  static provide = 'db' as const
  static Config = Config

  declare config: Config

  private rows: MemoryRow[] = []
  private readonly kv = new Map<string, string>()
  private readonly watchers = new Set<() => void>()
  /** What `recordTokenRefusal` / `recordModelIncapable` learned. Readable by a test. */
  readonly learned = { refusals: new Map<string, number>(), incapable: new Map<string, string>() }
  private seq = 0

  /** Overridable so a test can make cooldowns deterministic. */
  now: () => number = () => Date.now()

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    this.rows = this.config.targets.map((pair, index) => {
      const slash = pair.indexOf('/')
      const provider = slash > 0 ? pair.slice(0, slash) : pair
      const modelId = slash > 0 ? pair.slice(slash + 1) : 'default'
      return {
        id: `mem-${index + 1}`,
        provider,
        modelId,
        // Not a redaction of a real key: there is no real key. The string is
        // what an operator sees if this row is ever mounted by accident.
        apiKey: 'not-a-real-key',
        reserved_for: this.config.reservedFor || null,
        is_active: 1,
        rate_limited_until: null,
        cooldownUntil: 0,
      }
    })
    console.log(`[omniroute-db-memory] ${this.rows.length} fake connection(s): ${this.rows.map((r) => `${r.provider}/${r.modelId}`).join(', ')}`)
  }

  // ── DbAdapter ─────────────────────────────────────────────────────────────

  kind(): string {
    return 'memory'
  }

  createTargetCursor(query: TargetQuery = {}): TargetCursor {
    return new MemoryCursor(this.rows, query, this.now)
  }

  async rateLimitedProviders(): Promise<string[]> {
    const now = this.now()
    return [...new Set(this.rows.filter((r) => r.is_active && r.cooldownUntil > now).map((r) => r.provider))]
  }

  async recordTokenRefusal(modelStr: string, promptTokens: number): Promise<void> {
    if (!modelStr || !Number.isFinite(promptTokens) || promptTokens <= 0) return
    const prior = this.learned.refusals.get(modelStr) ?? Number.POSITIVE_INFINITY
    // Keep the SMALLEST refusal, matching `targetIterator.recordTokenRefusal`:
    // the ceiling converges downward onto the real limit, and one large refusal
    // must not erase a smaller one.
    this.learned.refusals.set(modelStr, Math.min(prior, promptTokens))
  }

  async recordModelIncapable(modelStr: string, reason: string): Promise<void> {
    if (!modelStr) return
    this.learned.incapable.set(modelStr, reason)
    for (const row of this.rows) {
      if (`${row.provider}/${row.modelId}` === modelStr) row.is_active = 0
    }
    this.notify()
  }

  async queryProviderConnections(opts: QueryTargetsOptions = {}): Promise<TargetRow[]> {
    return this.rows
      .filter((r) => (opts.provider ? r.provider === opts.provider : true))
      .filter((r) => (opts.reservedFor ? r.reserved_for == null || r.reserved_for === opts.reservedFor : r.reserved_for == null))
      .map((r) => ({ ...r, model: r.modelId }) as TargetRow)
  }

  async markFailed(connectionId: string, _status: number, cooldownMs: number): Promise<void> {
    const row = this.rows.find((r) => r.id === connectionId)
    if (row) row.cooldownUntil = this.now() + cooldownMs
    this.notify()
  }

  async markSucceeded(connectionId: string): Promise<void> {
    const row = this.rows.find((r) => r.id === connectionId)
    if (row) row.cooldownUntil = 0
    this.notify()
  }

  async createProviderConnection(data: ProviderConnectionInput): Promise<string> {
    const id = `mem-new-${++this.seq}`
    this.rows.push({
      id,
      provider: String(data.provider ?? 'memory'),
      modelId: String((data.defaultModel as string) ?? 'default'),
      apiKey: data.apiKey == null ? null : String(data.apiKey),
      reserved_for: data.reservedFor == null ? null : String(data.reservedFor),
      is_active: data.isActive === false || data.isActive === 0 ? 0 : 1,
      rate_limited_until: null,
      cooldownUntil: 0,
    })
    this.notify()
    return id
  }

  async updateProviderConnection(id: string, data: ProviderConnectionInput): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) return
    if (data.provider !== undefined) row.provider = String(data.provider)
    if (data.apiKey !== undefined) row.apiKey = data.apiKey == null ? null : String(data.apiKey)
    if (data.reservedFor !== undefined) row.reserved_for = data.reservedFor == null ? null : String(data.reservedFor)
    if (data.isActive !== undefined) row.is_active = data.isActive === false || data.isActive === 0 ? 0 : 1
    this.notify()
  }

  async deleteProviderConnection(id: string): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => r.id !== id)
    const removed = this.rows.length !== before
    if (removed) this.notify()
    return removed
  }

  async kvGet(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null
  }

  async kvSet(key: string, value: string): Promise<void> {
    this.kv.set(key, value)
  }

  /**
   * A real change feed, because this store can afford one.
   *
   * The SQLite adapter polls `MAX(updated_at)` and is honest about it; here the
   * writes all pass through this object, so a callback list is exact. Two
   * adapters answering the same method by different means, with the caller
   * unable to tell, is what the seam is for.
   */
  watchProviderConnections(callback: () => void): () => void {
    this.watchers.add(callback)
    return () => {
      this.watchers.delete(callback)
    }
  }

  private notify() {
    for (const watcher of this.watchers) {
      try {
        watcher()
      } catch {
        // A subscriber that throws must not stop the next one being told.
      }
    }
  }

  async dispose(): Promise<void> {
    this.rows = []
    this.kv.clear()
    this.watchers.clear()
  }
}

export default MemoryAdapterService
