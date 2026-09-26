/**
 * @omniroute/gateway — the HTTP surface.
 *
 * ## What moved here, and what did not
 *
 * `server-elysia.ts` did four jobs at once: it loaded `.env`, discovered ~40
 * Next.js route modules out of `src/app/api/`, ran admission control, and
 * served. Three of those belong elsewhere and are elsewhere now — the env goes
 * with the store that needs the key, and the route discovery goes nowhere at
 * all, because those routes are the dashboard and the dashboard is not on the
 * live path.
 *
 * What is left is the part that has no other home: **admission control**. The
 * queue, the two separate concurrency pools, and the abort wiring are not
 * transport plumbing — each line is a refusal decision with a recorded reason,
 * and every one of them is why a caller can tell "OmniRoute is busy" from
 * "every provider is down". That distinction is the whole point of
 * `failureDomain.ts`, and it dies the moment someone re-answers a queue
 * rejection with a bare 503. So it is ported, not imported: there is nothing to
 * import it from once `server-elysia.ts` is gone.
 *
 * The routing itself is `handleThinGateway`, imported untouched.
 *
 * ## Why the imports are dynamic
 *
 * `thinGateway.ts` statically imports `targetIterator.ts`, which imports
 * `core.ts`, which resolves `DATA_DIR` as it evaluates. Importing it from this
 * file's top level would open the store before `@omniroute/db-sqlite`'s config
 * had been read — i.e. against `~/.omniroute` regardless of what the
 * composition said. `inject` guarantees this row applies after the store row,
 * and the dynamic import inside `Service.init` is what makes that ordering
 * actually reach the module.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { FailureCode } from '../../../src/server/headless/failureDomain.ts'
// The *interface*, not an implementation. This is the only thing this row is
// allowed to know about storage, and importing the type rather than a class is
// what makes that enforceable rather than a promise.
import type { DbAdapter } from '../../omniroute-db/src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gateway: GatewayService
  }
}

export const name = 'omniroute-gateway'

export interface Config {
  port: number
  hostname: string
  /**
   * How many upstream requests this router carries at once.
   *
   * `/health` publishes this, and RLM's `capacity.ts` reads it there to size
   * its own fleet of agent subprocesses — so a ceiling chosen for a server
   * becomes a subprocess count on a laptop. Zero means "derive from the
   * machine": four per core, capped, which keeps a mostly-waiting router busy
   * without pretending a laptop is a datacentre.
   */
  maxConcurrent: number
  /** Separate pool for internal (model-sync) traffic, so it cannot starve chat. */
  maxConcurrentInternal: number
  maxQueueDepth: number
  queueTimeoutMs: number
  maxBodyBytes: number
  /** Retries when the port is still held by a predecessor launchd just killed. */
  bindRetries: number
  bindRetryDelayMs: number
}

export const Config: Schema<Config> = Schema.object({
  port: Schema.number().default(0).description('TCP port to listen on. 0 = $PORT, else 20128 (what launchd sets).'),
  hostname: Schema.string().default('0.0.0.0').description('Interface to bind.'),
  maxConcurrent: Schema.number().default(0).description('In-flight chat requests. 0 = derive from CPU count (4/core, capped at 32).'),
  maxConcurrentInternal: Schema.number().default(16).description('In-flight internal requests, pooled separately from chat.'),
  maxQueueDepth: Schema.number().default(500).description('Waiting requests before refusing outright.'),
  queueTimeoutMs: Schema.number().default(30_000).description('How long a request may wait for a slot.'),
  maxBodyBytes: Schema.number().default(2 * 1024 * 1024).description('Largest request body accepted.'),
  bindRetries: Schema.number().default(5).description('Attempts to bind the port before giving up.'),
  bindRetryDelayMs: Schema.number().default(5000).description('Wait between bind attempts.'),
}) as unknown as Schema<Config>

/** Local admission-control reasons → the shared refusal contract. */
const QUEUE_REASON_TO_FAILURE: Record<'queue-full' | 'queue-timeout' | 'client-disconnected', FailureCode> = {
  'queue-full': 'admission_queue_full',
  'queue-timeout': 'admission_queue_timeout',
  'client-disconnected': 'client_disconnected',
}

class QueueRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: 'queue-full' | 'queue-timeout' | 'client-disconnected',
  ) {
    super(message)
    this.name = 'QueueRejectedError'
  }
}

interface QueueEntry {
  cancelled: boolean
  run(): void
}

/**
 * The listening socket, shared across generations of this row.
 *
 * A hot swap of the gateway (its own source, `thinGateway.ts`, a route module)
 * used to `stop()` the server in the old fiber's disposer and `serve()` again in
 * the new one — a window of refused connections on every save, on the one port
 * rlm, Iris, CLIProxyAPI and the provisioner all depend on. The socket now lives
 * here: the first generation binds it, every later generation just becomes the
 * handler `fetch` delegates to, and the socket closes only when a generation
 * leaves with no successor after a grace period (a real removal of the row).
 */
interface SharedListener {
  server: { stop(closeActiveConnections?: boolean): void; port?: number }
  port: number
  current: { handle(request: Request): Promise<Response> } | null
  owners: number
  closeTimer?: ReturnType<typeof setTimeout>
}
const RELEASE_GRACE_MS = 3000
const listeners = (): Map<number, SharedListener> =>
  ((globalThis as any).__omniGatewayListeners ??= new Map<number, SharedListener>())

/** Same as server-elysia: DATA_DIR/.env fills anything the environment didn't set. */
async function loadDataDirEnv() {
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dataDir = process.env.DATA_DIR || join(process.env.HOME || '', '.omniroute')
  const envPath = join(dataDir, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

export class GatewayService extends Service {
  static provide = 'gateway' as const
  // The store must be open before `thinGateway.ts` is imported; the log owns
  // the refusal contract every rejection here is built through; and the seam is
  // named so that `audit()` is reachable — cordis refuses a property read on a
  // service this row did not declare, which is the point: a dependency you can
  // reach without naming is a dependency nobody can see.
  static inject = ['db', 'omniLog', 'dbSeam']
  static Config = Config

  declare config: Config

  private server: { stop(closeActiveConnections?: boolean): void; port?: number } | null = null
  private handleThinGateway: ((req: { body: Record<string, unknown>; model: string; stream: boolean; signal?: AbortSignal }) => Promise<Response>) | null = null
  private parseChatBody:
    | ((request: Request) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }>)
    | null = null
  private listModels: ((request?: Request) => Promise<Response>) | null = null
  private routes: import('../../../src/server/headless/coreRoutes.ts').CompiledRoute[] = []
  private coreRoutes: typeof import('../../../src/server/headless/coreRoutes.ts') | null = null
  private port = 0

  /**
   * The store, as an interface.
   *
   * Held rather than read from `this.ctx.db` at each use, because the type of
   * `ctx.db` is whichever adapter's module augmented the Context — today
   * `SqliteAdapterService`, tomorrow a Convex one — and a row that types its
   * dependency as a concrete sibling has not decoupled from it, it has only
   * stopped importing it. Narrowed to `DbAdapter` once, here.
   */
  private store: DbAdapter | null = null

  private inFlight = 0
  private internalInFlight = 0
  private readonly queue: QueueEntry[] = []
  private readonly internalQueue: QueueEntry[] = []
  private maxConcurrent = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    await loadDataDirEnv()
    const os = await import('node:os')
    // The environment wins over the composition, as it did for server-elysia:
    // launchd's plist is where OMNIROUTE_MAX_CONCURRENT and PORT are tuned.
    const envMax = Number(process.env.OMNIROUTE_MAX_CONCURRENT || 0)
    this.maxConcurrent =
      envMax > 0
        ? envMax
        : this.config.maxConcurrent > 0
          ? this.config.maxConcurrent
          : Math.min(32, Math.max(4, (os.cpus()?.length || 4) * 4))
    this.port = this.config.port > 0 ? this.config.port : Number(process.env.PORT || 20128)

    const mod = await import('../../../src/server/headless/thinGateway.ts')
    this.handleThinGateway = mod.handleThinGateway
    // Same modules server-elysia serves: an empty or cut-off body is a 400 with
    // an OpenAI-style error, not a thrown SyntaxError turned into a 500; and
    // `/v1/models` is not dashboard — rlm, CLIProxyAPI and Iris list models
    // through it. Imported here, after the store row, for the reason above.
    this.parseChatBody = (await import('../../../src/server/headless/parseChatBody.ts')).parseChatBody
    this.listModels = (await import('../../../src/app/api/v1/models/route.ts')).GET

    // Now that a store is definitely open, prove the adapter behind it is
    // whole. A missing seam method surfaces here, at boot, instead of on the
    // first request that happens to need it.
    const adapter = this.ctx.db as unknown as DbAdapter
    this.ctx.dbSeam?.audit(adapter)
    this.auditCursor(adapter)
    this.store = adapter

    // The seam, made real. Until this line the router imported `TargetIterator`
    // by name and opened a raw SQLite handle to ask which providers were rate
    // limited — so `ctx.db` was a service nothing on the live path consumed,
    // and swapping it would have swapped nothing. Now every connection question
    // a chat completion asks is answered by this object.
    //
    // `ctx.effect` and not a bare call: `setRouterStore` hands back its own
    // undo, and this row must put the previous store back when it unloads, or a
    // reloaded gateway would leave the process pointing at a disposed adapter.
    this.ctx.effect(
      () =>
        mod.setRouterStore({
          createTargetCursor: (query) => adapter.createTargetCursor(query) as any,
          rateLimitedProviders: () => adapter.rateLimitedProviders(),
          recordTokenRefusal: (model, tokens) => adapter.recordTokenRefusal(model, tokens),
          recordModelIncapable: (model, reason) => adapter.recordModelIncapable(model, reason),
        }),
      'gateway.store',
    )
    console.log(`[omniroute-gateway] routing through the "${adapter.kind()}" store`)

    // Everything else server-elysia served: the provisioner's /api/providers,
    // /v1/messages, /v1/responses, embeddings, combos, keys, monitoring… The
    // same discovery, from the same module, so the two hosts cannot drift.
    this.coreRoutes = await import('../../../src/server/headless/coreRoutes.ts')
    const { fileURLToPath } = await import('node:url')
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
    this.routes = this.coreRoutes.discoverRoutes(this.coreRoutes.apiDirFor(repoRoot))
    console.log(`[omniroute-gateway] ${this.routes.length} core routes loaded`)

    // Local-CLI passthrough providers own connection rows the failover path can
    // quarantine; server-elysia seeded them at boot, so this host does too.
    try {
      const { seedLocalCliConnections } = await import('../../../src/lib/db/seedLocalCliConnections.ts')
      seedLocalCliConnections()
    } catch (err) {
      console.warn('[omniroute-gateway] local-CLI connection seeding failed:', err)
    }

    // The daemon's own stdout log (launchd appends it forever otherwise).
    try {
      const { startStdoutLogRotation, resolveStdoutLogPath } = await import('../../../src/lib/stdoutLogRotation.ts')
      const { join } = await import('node:path')
      const dataDir = process.env.DATA_DIR || join(process.env.HOME || '', '.omniroute')
      const stdoutLog = resolveStdoutLogPath(dataDir)
      if (stdoutLog) startStdoutLogRotation(stdoutLog)
    } catch (err) {
      console.warn('[omniroute-gateway] stdout log rotation setup failed:', err)
    }

    await this.listen()
    this.ctx.effect(() => () => this.release(), 'gateway.server')
  }

  /**
   * Leave the shared socket. A successor that adopted it within the grace
   * period keeps it open; only a generation with no successor closes it.
   */
  private release() {
    const shared = listeners().get(this.port)
    this.server = null
    if (!shared) return
    shared.owners--
    if (shared.current === this) shared.current = null
    clearTimeout(shared.closeTimer)
    shared.closeTimer = setTimeout(() => {
      if (shared.owners > 0) return
      shared.server.stop(true)
      listeners().delete(this.port)
    }, RELEASE_GRACE_MS)
    ;(shared.closeTimer as { unref?: () => void }).unref?.()
  }

  /**
   * Prove the adapter can hand back a cursor the router can actually drive.
   *
   * `audit()` checks the adapter's own members; it cannot check what
   * `createTargetCursor` returns without calling it. An adapter that passes the
   * first check and fails this one would look healthy at boot and throw on the
   * first request — which is the failure mode the seam row exists to move
   * forward in time, so it is worth one throwaway cursor at startup.
   */
  private auditCursor(adapter: DbAdapter) {
    try {
      const gaps = this.ctx.dbSeam?.missingCursor(adapter.createTargetCursor({}))
      if (gaps?.length) console.warn(`[omniroute-gateway] ${adapter.kind()} cursor is missing: ${gaps.join(', ')}`)
    } catch (err) {
      console.warn('[omniroute-gateway] adapter could not produce a cursor:', err)
    }
  }

  /** Where this gateway is answering. Null before it binds. */
  address(): string | null {
    return this.server ? `http://${this.config.hostname}:${this.port}` : null
  }

  private async listen() {
    const existing = listeners().get(this.port)
    if (existing) {
      // A predecessor generation already owns the socket: take over its
      // requests without closing anything.
      clearTimeout(existing.closeTimer)
      existing.owners++
      existing.current = this
      this.server = existing.server
      console.log(`[omniroute-gateway] took over the listener on :${this.port} (no rebind)`)
      return
    }
    const serve = (globalThis as { Bun?: { serve: (o: unknown) => any } }).Bun?.serve
    if (!serve) throw new Error('[omniroute-gateway] Bun.serve is unavailable — this row needs the Bun runtime')

    let lastError: unknown
    for (let attempt = 1; attempt <= this.config.bindRetries; attempt++) {
      try {
        const port = this.port
        const server = serve({
          port,
          hostname: this.config.hostname,
          maxRequestBodySize: this.config.maxBodyBytes,
          // Delegates to whichever generation is current, so a swap never
          // rebinds. Before any generation claims it (never, in practice) or
          // after the last leaves, the answer is a plain 503.
          fetch: (request: Request) => {
            const current = listeners().get(port)?.current
            return current
              ? current.handle(request)
              : Response.json({ error: { message: 'Gateway reloading', type: 'unavailable' } }, { status: 503 })
          },
        })
        listeners().set(port, { server, port, current: this, owners: 1 })
        this.server = server
        console.log(`[omniroute-gateway] listening on http://${this.config.hostname}:${port}`)
        console.log(`[omniroute-gateway] RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`)
        return
      } catch (err) {
        lastError = err
        if (attempt >= this.config.bindRetries || !/port.*in use|EADDRINUSE/i.test(String((err as Error)?.message ?? err))) break
        console.warn(`[omniroute-gateway] port ${this.port} in use (${attempt}/${this.config.bindRetries}) — retrying`)
        await new Promise((r) => setTimeout(r, this.config.bindRetryDelayMs))
      }
    }
    throw lastError
  }

  // ── admission control ─────────────────────────────────────────────────────

  private tryAcquire(internal: boolean): boolean {
    if (internal) {
      if (this.internalInFlight >= this.config.maxConcurrentInternal) return false
      this.internalInFlight++
      return true
    }
    if (this.inFlight >= this.maxConcurrent) return false
    this.inFlight++
    return true
  }

  private acquireSlot(internal: boolean, signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire(internal)) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(new QueueRejectedError('Client disconnected', 'client-disconnected'))
    const queue = internal ? this.internalQueue : this.queue
    if (queue.length >= this.config.maxQueueDepth) {
      return Promise.reject(new QueueRejectedError(`Queue full (${this.config.maxQueueDepth})`, 'queue-full'))
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const entry: QueueEntry = { cancelled: false, run: () => settle(true) }
      const settle = (granted: boolean, err?: QueueRejectedError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (granted) {
          if (internal) this.internalInFlight++
          else this.inFlight++
          resolve()
        } else {
          entry.cancelled = true
          reject(err)
        }
      }
      const onAbort = () => settle(false, new QueueRejectedError('Client disconnected', 'client-disconnected'))
      timer = setTimeout(
        () => settle(false, new QueueRejectedError(`Waited ${this.config.queueTimeoutMs}ms`, 'queue-timeout')),
        this.config.queueTimeoutMs,
      )
      ;(timer as { unref?: () => void }).unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(entry)
    })
  }

  private releaseSlot(internal: boolean) {
    if (internal) this.internalInFlight--
    else this.inFlight--
    const queue = internal ? this.internalQueue : this.queue
    while (queue.length > 0) {
      const next = queue.shift()!
      if (!next.cancelled) {
        next.run()
        return
      }
    }
  }

  private rejection(err: QueueRejectedError): Response {
    return this.ctx.omniLog.refuse(QUEUE_REASON_TO_FAILURE[err.reason], err.message)
  }

  // ── serving ───────────────────────────────────────────────────────────────

  /** The same shape `server-elysia.ts` published, because RLM parses it. */
  health(): Response {
    return Response.json({
      status: 'ok',
      mode: 'bun',
      // Which adapter is actually answering. The one field that makes a
      // hot-swap observable from outside the process; without it "the store was
      // replaced" is a claim rather than a reading.
      store: this.store?.kind() ?? 'none',
      inFlight: this.inFlight,
      queued: this.queue.length,
      internalInFlight: this.internalInFlight,
      internalQueued: this.internalQueue.length,
      maxConcurrent: this.maxConcurrent,
      queueDepthCap: this.config.maxQueueDepth,
      queueWaitTimeoutMs: this.config.queueTimeoutMs,
    })
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/health' || path === '/') return this.health()

    if ((path === '/v1/models' || path === '/v1/models/') && request.method === 'GET' && this.listModels) {
      return this.listModels(request)
    }

    if (path === '/v1/chat/completions' && request.method === 'POST') {
      const internal = Boolean(request.headers.get('x-model-sync-internal-auth'))
      try {
        const parsed = await this.parseChatBody!(request)
        if (!parsed.ok) return parsed.response
        const body = parsed.body
        const model = String(body.model || 'auto/best-free')
        const stream = body.stream === true
        try {
          // The client's signal must be passed: without it the
          // `client-disconnected` branch is unreachable, and a caller that
          // hung up while queued still consumed a slot when its turn came.
          await this.acquireSlot(internal, request.signal)
        } catch (err) {
          if (err instanceof QueueRejectedError) return this.rejection(err)
          throw err
        }
        try {
          return await this.handleThinGateway!({ body, model, stream, signal: request.signal })
        } finally {
          this.releaseSlot(internal)
        }
      } catch (err) {
        console.error('[omniroute-gateway] thin gateway error:', err)
        return Response.json({ error: { message: 'Gateway error', type: 'server_error' } }, { status: 500 })
      }
    }

    return this.dispatchCoreRoute(request, url)
  }

  /** Every other core route, exactly as server-elysia dispatched it. */
  private async dispatchCoreRoute(request: Request, url: URL): Promise<Response> {
    const routes = this.coreRoutes
    if (!routes) return Response.json({ error: { message: 'Not found', type: 'not_found' } }, { status: 404 })
    let routePath = url.pathname
    if (!routePath.startsWith('/api/')) routePath = '/api' + routePath

    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > this.config.maxBodyBytes) {
      return Response.json(
        { error: { message: `Body too large (${contentLength} bytes, max ${this.config.maxBodyBytes})`, type: 'invalid_request' } },
        { status: 413 },
      )
    }

    const match = routes.matchRoute(routePath, this.routes)
    if (!match) return Response.json({ error: { message: 'Not found', type: 'not_found' } }, { status: 404 })

    let handler: import('../../../src/server/headless/coreRoutes.ts').RouteHandler
    try {
      handler = await routes.loadRouteHandler(match.route)
    } catch (err) {
      console.error(`[omniroute-gateway] failed to load route ${match.route.originalPath}:`, err)
      return Response.json({ error: { message: 'Route module load failed', type: 'server_error' } }, { status: 500 })
    }

    const method = request.method.toUpperCase() as keyof typeof handler
    const methodFn = handler[method]
    if (typeof methodFn !== 'function') {
      const allow = routes.HTTP_METHODS.filter((m) => typeof handler[m] === 'function').join(', ')
      return Response.json(
        { error: { message: `Method ${String(method)} not allowed`, type: 'invalid_request' } },
        { status: 405, headers: { Allow: allow } },
      )
    }

    const internal = Boolean(request.headers.get('x-model-sync-internal-auth'))
    try {
      await this.acquireSlot(internal, request.signal)
      try {
        return await methodFn(request, { params: match.params, searchParams: url.searchParams })
      } finally {
        this.releaseSlot(internal)
      }
    } catch (err) {
      if (err instanceof QueueRejectedError) return this.rejection(err)
      console.error('[omniroute-gateway] unhandled error:', err)
      return Response.json({ error: { message: 'Internal server error', type: 'server_error' } }, { status: 500 })
    }
  }
}

export default GatewayService
