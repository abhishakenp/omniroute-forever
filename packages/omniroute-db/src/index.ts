/**
 * @omniroute/db — the database seam.
 *
 * This row stores nothing and queries nothing. It exists so that the question
 * "what does OmniRoute need from a database?" has an answer that is not "read
 * all 1,600 lines of core.ts and find out".
 *
 * The answer is `DbAdapter` below. An adapter row — `@omniroute/db-sqlite`
 * today, `@omniroute/db-memory` in a test, a Convex one later — provides
 * `ctx.db`. This row provides `ctx.dbSeam`, which knows the contract but no
 * implementation of it, and can therefore say at boot whether the adapter that
 * actually loaded satisfies it. That check is the only reason a seam deserves a
 * row of its own: an interface alone is erased at runtime, so a Convex adapter
 * missing `watchProviderConnections` would fail on the first provider edit,
 * hours after boot, in a place that looks nothing like the cause.
 *
 * ## The rule this file lives by
 *
 * **If the gateway needs it, the interface must be able to say it.** The seam
 * earns nothing if the router reaches past it — and until Scope 8 the router
 * did: `thinGateway.ts` constructed a `TargetIterator` (a SQLite class), and
 * opened a raw `getDbInstance().prepare(...)` to ask which providers were rate
 * limited. Those two reads were the whole of the leak, and they are now
 * `createTargetCursor()` and `rateLimitedProviders()` on this interface. The
 * two `record*` learning writes followed them for the same reason.
 *
 * So the surface below is larger than it was, and it should be: it is exactly
 * what a chat completion touches, and not one member more. Anything OmniRoute
 * does not do on that path is still not here.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dbSeam: DbSeamService
  }
}

export const name = 'omniroute-db'

/** A row of `provider_connections` as the routing path reads it. */
export interface TargetRow {
  id: string
  provider: string
  model?: string | null
  /** Consumer this key is held for, e.g. `iris/always`. NULL = general pool. */
  reserved_for?: string | null
  [column: string]: unknown
}

export interface QueryTargetsOptions {
  reservedFor?: string
  provider?: string
  freeOnly?: boolean
}

/**
 * One thing the router may try: a provider, a model, and the credential to
 * reach it with.
 *
 * Structurally identical to `targetIterator.ts`'s `TargetRow` — deliberately,
 * because the shape is not SQLite's, it is the router's, and restating it here
 * is what lets a non-SQLite adapter produce one. The name differs so the two
 * can be imported into the same file without an alias.
 */
export interface TargetCandidate {
  connectionId: string
  provider: string
  modelId: string
  /** `provider/model`, the string the caller and the error list both see. */
  modelStr: string
  apiKey: string | null
  authType: string | null
  defaultModel: string | null
  priority: number
}

/** How a request narrows the candidate set. One per request. */
export interface TargetQuery {
  freeProvidersOnly?: boolean
  specificProvider?: string
  specificModel?: string
  /** Estimated prompt size — models whose window cannot hold it are not candidates. */
  promptTokens?: number
  /** Tokens the reply may occupy, which the window must also hold. */
  outputTokens?: number
  /** Consumer tag, e.g. `iris/always`. Unset means the general pool only. */
  reservedFor?: string
}

/**
 * A request-scoped cursor over candidates.
 *
 * Synchronous on purpose. The tried-set that makes it request-scoped is
 * in-memory state, and every implementation so far answers `nextTarget()` from
 * a snapshot it took when it was constructed — so making these `Promise`s would
 * buy an await per attempt and no adapter any freedom. `createTargetCursor` is
 * the place an adapter that must do I/O first does it.
 */
export interface TargetCursor {
  /** The next thing worth trying, or null when this request has run out. */
  nextTarget(): TargetCandidate | null
  /** Record a failure so this cursor, and the next request, skip the credential. */
  markFailed(connectionId: string, status: number, cooldownMs?: number): void
  /** Record a success — clears backoff, records the use. */
  markSucceeded(connectionId: string): void
  /** Providers this cursor has already handed out. Drives provisioning triggers. */
  readonly triedProviders: Set<string>
}

/**
 * What a write to `provider_connections` may carry.
 *
 * The plan assumed this type already existed. It did not: `providers.ts:44`
 * declares `type JsonRecord = Record<string, unknown>` and both
 * `createProviderConnection` (:380) and `updateProviderConnection` (:830) take
 * that. So it is defined here, and it is deliberately **open**.
 *
 * Naming the four fields below is worth doing — they are the ones the
 * provisioner path and the reserved-alias work actually write, and a typo in
 * `provider` is a row that routes to nothing. Closing the type is not: the
 * table has 46 columns, `_insertConnectionRow` (`providers.ts:663`) binds 45 of
 * them by camelCase name, and `caseMapping.ts` accepts either case for each.
 * Restating all 46 here would create a second copy of a schema that changes by
 * migration, and the first symptom of the drift would be a dashboard write
 * silently rejected by a type that had not caught up. The index signature is
 * the honest statement that this seam knows four columns and passes the rest
 * through.
 */
export interface ProviderConnectionInput {
  provider?: string
  apiKey?: string | null
  /** Consumer tag, e.g. `iris/always`. Null/absent = general pool. */
  reservedFor?: string | null
  isActive?: boolean | number
  [column: string]: unknown
}

/**
 * Everything the live path asks of a store.
 *
 * Deliberately not a superset. `createTargetCursor` + `rateLimitedProviders` +
 * the two `record*` writes are the whole of what a chat completion touches;
 * `queryProviderConnections` and the CRUD and kv members are what the
 * provisioner hook and boot-time seeding touch. Nothing else.
 */
export interface DbAdapter {
  /**
   * What kind of store this is — `sqlite`, `memory`, `convex`.
   *
   * Not decoration: it is published on `/health`, and it is the only way an
   * operator can tell from outside which adapter a running gateway is on. A
   * hot-swap that cannot be observed is a hot-swap nobody can trust.
   */
  kind(): string
  /** A cursor for one request. Never shared between requests — it holds a tried-set. */
  createTargetCursor(query?: TargetQuery): TargetCursor
  /**
   * Providers holding at least one active-but-rate-limited credential.
   *
   * These were never tried this request — the cursor skips them — so they are
   * invisible to `triedProviders`, and without them exhaustion would trigger
   * provisioning for only the providers that failed loudly.
   */
  rateLimitedProviders(): Promise<string[]>
  /** Remember that `provider/model` refused a prompt this big. An optimisation, never a failure path. */
  recordTokenRefusal(modelStr: string, promptTokens: number): Promise<void>
  /** Remember that `provider/model` is not a chat model at all. Permanent. */
  recordModelIncapable(modelStr: string, reason: string): Promise<void>
  queryProviderConnections(opts?: QueryTargetsOptions): Promise<TargetRow[]>
  markFailed(connectionId: string, status: number, cooldownMs: number): Promise<void>
  markSucceeded(connectionId: string): Promise<void>
  createProviderConnection(data: ProviderConnectionInput): Promise<string>
  updateProviderConnection(id: string, data: ProviderConnectionInput): Promise<void>
  deleteProviderConnection(id: string): Promise<boolean>
  kvGet(key: string): Promise<string | null>
  kvSet(key: string, value: string): Promise<void>
  watchProviderConnections(callback: () => void): () => void
  dispose(): Promise<void>
}

/**
 * The contract as data.
 *
 * An interface is a compile-time fiction; this array is what survives to
 * runtime and is what `check()` compares against. Keep the two in step — the
 * unit of drift here is one missing string, and the cost is a silent adapter.
 */
export const DB_ADAPTER_METHODS = [
  'kind',
  'createTargetCursor',
  'rateLimitedProviders',
  'recordTokenRefusal',
  'recordModelIncapable',
  'queryProviderConnections',
  'markFailed',
  'markSucceeded',
  'createProviderConnection',
  'updateProviderConnection',
  'deleteProviderConnection',
  'kvGet',
  'kvSet',
  'watchProviderConnections',
  'dispose',
] as const

/**
 * The members a cursor must have. Same reasoning as `DB_ADAPTER_METHODS`:
 * `triedProviders` is a getter, not a method, so it is checked separately.
 */
export const TARGET_CURSOR_METHODS = ['nextTarget', 'markFailed', 'markSucceeded'] as const

export interface Config {
  /**
   * Refuse the boot when the loaded adapter is incomplete.
   *
   * Off by default, because a partial adapter that serves chat completions is
   * strictly better than no gateway at all, and the missing method may be one
   * this deployment never calls. On for a deployment that would rather find out
   * at boot than at 3am.
   */
  strict: boolean
}

export const Config: Schema<Config> = Schema.object({
  strict: Schema.boolean()
    .default(false)
    .description('Throw at boot if ctx.db is missing a DbAdapter method, instead of warning.'),
}) as unknown as Schema<Config>

export class DbSeamService extends Service {
  static provide = 'dbSeam' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    // The adapter is a sibling row and may load after this one, so the check
    // cannot run here. `ctx.inject` would make this row wait on the very thing
    // it is meant to audit; instead the audit is a method the gateway calls
    // once it has a `ctx.db` in hand.
  }

  /** The contract, for anything that wants to print or test it. */
  describe(): readonly string[] {
    return DB_ADAPTER_METHODS
  }

  /** Which contract members this object does not have. Empty means complete. */
  missing(adapter: unknown): string[] {
    if (!adapter || typeof adapter !== 'object') return [...DB_ADAPTER_METHODS]
    const bag = adapter as Record<string, unknown>
    return DB_ADAPTER_METHODS.filter((m) => typeof bag[m] !== 'function')
  }

  /**
   * Which cursor members this object does not have.
   *
   * Separate from `missing()` because a cursor is not an adapter, and because
   * an adapter can pass its own audit and still hand back a cursor the router
   * cannot drive — which would fail on the first request rather than at boot,
   * i.e. exactly the failure this row exists to prevent.
   */
  missingCursor(cursor: unknown): string[] {
    if (!cursor || typeof cursor !== 'object') return [...TARGET_CURSOR_METHODS, 'triedProviders']
    const bag = cursor as Record<string, unknown>
    const gaps: string[] = TARGET_CURSOR_METHODS.filter((m) => typeof bag[m] !== 'function')
    if (!(bag.triedProviders instanceof Set)) gaps.push('triedProviders')
    return gaps
  }

  /**
   * Audit an adapter against the contract.
   *
   * The adapter is passed in rather than read off `ctx.db`, and that is not an
   * ergonomic choice: cordis refuses a property read on a service the reading
   * row has not declared in `inject`, and declaring `db` here would make the
   * seam wait for an adapter — inverting the dependency, so the row that
   * defines the contract could not load until something had already claimed to
   * implement it. The caller already holds the adapter; it hands it over.
   *
   * @returns the missing method names; `null` when nothing was passed at all.
   */
  audit(adapter: unknown): string[] | null {
    if (!adapter) return null
    const gaps = this.missing(adapter)
    if (gaps.length) {
      const message = `[omniroute-db] adapter is missing ${gaps.length} of ${DB_ADAPTER_METHODS.length} seam methods: ${gaps.join(', ')}`
      if (this.config.strict) throw new Error(message)
      console.warn(message)
    }
    return gaps
  }
}

export default DbSeamService
