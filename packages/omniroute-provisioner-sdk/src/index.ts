/**
 * @omniroute/provisioner-sdk — the account-provisioner, as a row.
 *
 * ## What this is for
 *
 * `src/sse/services/provisionerHook.ts` already talks to the provisioner, and
 * it is 612 lines of retry ladders, cooldown bookkeeping and delete semantics
 * earned the hard way. This row does not replace it and must not: it is the
 * *seam*, the thing that knows the provisioner is at an address and speaks
 * HTTP, so that a later scope can move the hook onto it a piece at a time
 * rather than in one rewrite nobody can review.
 *
 * ## The rule this file exists to enforce
 *
 * **The provisioner answers with credentials.** `POST /provision/:provider` in
 * blocking mode returns `{ provider, success, email, apiKey, omnirouteId,
 * verified, durationMs }` — a live API key and the address of the account it
 * belongs to, in the response body (`account-provisioner/src/sdk/server.ts`
 * :532-540, and again at :505 for the async path's SSE payload). Anything that
 * passes that body through to a return value, a log line, or an error string
 * has published a credential.
 *
 * So nothing here passes a body through. Every response is projected through an
 * **allow-list** of field names before it becomes a value this row will hand
 * back. An allow-list and not a deny-list, deliberately: a deny-list of
 * `apiKey` and `email` is correct exactly until the provisioner grows a
 * `refreshToken`, and the failure is silent, permanent and retroactive — the
 * secret is already in the log by the time anyone notices. The allow-list fails
 * the other way: a new field is dropped until someone adds it, which costs a
 * follow-up commit and nothing else.
 *
 * The same rule governs failures. `scrub()` runs over any upstream text before
 * it reaches an `Error`, because a 500 from the provisioner can carry anything
 * its own stack put there.
 *
 * ## Why `trigger()` defaults to async
 *
 * `?async=true` makes the provisioner answer immediately with a job id and
 * stream the result over SSE — so the credential is never in the response this
 * row reads at all. That is defence in depth rather than the defence: the
 * allow-list would drop it either way. But a blocking provision takes as long
 * as a browser signup takes, which is minutes, and holding a socket open that
 * long for an answer we are contractually obliged to discard is the wrong shape
 * twice over.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type Schemastery from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    provisionerSdk: ProvisionerSdkService
  }
}

export const name = 'omniroute-provisioner-sdk'

/** What `trigger()` will say. Nothing here can carry a credential. */
export interface TriggerResult {
  ok: boolean
  /** HTTP status, or 0 when nothing answered at all. */
  status: number
  provider: string
  /** True when the provisioner accepted the job. False for a refusal or a skip. */
  triggered: boolean
  /** The provisioner's handle for the run, when it gave one. */
  jobId?: string
  /** Set when the provisioner declined: `cooldown`, `banned`, … */
  skippedReason?: string
  /** Where results stream, when the provisioner named one. */
  streamUrl?: string
  error?: string
}

export interface ProvisionerStatus {
  ok: boolean
  status: number
  accounts: { total: number; active: number; byProvider: Record<string, number> }
  omniroute: { running: boolean; connections: number }
  providers: string[]
  error?: string
}

export interface Config {
  enabled: boolean
  endpoint: string
  triggerTimeoutMs: number
  readTimeoutMs: number
  async: boolean
  drainMs: number
}

export const Config: Schemastery<Config> = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description(
      'Whether this row may call the provisioner at all. Off, it still mounts and still answers `report()`, so a composition can be inspected without letting it create accounts.',
    ),
  endpoint: Schema.string()
    .default('http://localhost:20129')
    .description(
      "Where account-provisioner is listening, without a trailing path. 20129 is its own default and it is not configurable by environment — `src/sdk/server.ts:137` reads a `--port` flag and nothing else — so this row is the only place the address can be changed without editing that repo.",
    ),
  triggerTimeoutMs: Schema.natural()
    .default(30_000)
    .description(
      'How long a provisioning trigger may take to be *accepted*. Not how long provisioning takes: in async mode the provisioner answers as soon as it has queued the job, and the account itself is minutes away over SSE.',
    ),
  readTimeoutMs: Schema.natural()
    .default(5_000)
    .description('How long the read-only calls (`health`, `status`, `providers`) wait. Short — the only question they ask is what is already known.'),
  async: Schema.boolean()
    .default(true)
    .description('Ask the provisioner to queue the job and answer immediately, rather than holding the socket open for a browser signup. See the file header.'),
  drainMs: Schema.natural()
    .default(10_000)
    .description('How long an unload waits for calls already in flight before giving up on them. Waiting, not killing: an aborted trigger may still have created the account.'),
}) as unknown as Schemastery<Config>

/**
 * Last-resort redaction for text this row did not shape.
 *
 * The allow-list is what actually keeps credentials out; this covers the one
 * case the allow-list cannot — free-form upstream error text, which may quote
 * anything. Same patterns as `@iris/rlm-sdk`, plus the provisioner's own
 * `email` field, because an account address is an account detail.
 */
export function scrub(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***REDACTED***')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '***REDACTED***')
    .replace(/("?(?:api[-_]?key|apikey|authorization|token|secret|password|email)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***REDACTED***')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***REDACTED***')
}

/** Read one allow-listed string, or nothing. Never coerces an object into a string. */
const str = (bag: Record<string, unknown>, key: string): string | undefined =>
  typeof bag[key] === 'string' || typeof bag[key] === 'number' ? String(bag[key]) : undefined

export class ProvisionerSdkService extends Service {
  static provide = 'provisionerSdk' as const
  static Config = Config

  declare config: Config

  /**
   * In-flight calls, so an unload can wait for them.
   *
   * A trigger that is cut off mid-flight is the worst outcome available: the
   * provisioner may already be driving a browser through a signup, and killing
   * the socket does not stop it — it only removes the one process that knew a
   * job was running.
   */
  private readonly inFlight = new Set<Promise<unknown>>()

  private calls = 0
  private failures = 0
  private lastMs = 0
  private lastError?: string

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    this.ctx.effect(() => () => {
      void this.drain(this.config.drainMs)
    }, 'provisioner-sdk.drain')
  }

  private async drain(ms: number) {
    if (!this.inFlight.size) return
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((done) => setTimeout(done, ms).unref?.()),
    ])
  }

  /** Wrap a call so it is counted, drained on unload, and never throws upward. */
  private async track<T>(work: () => Promise<T>, onError: (why: string) => T): Promise<T> {
    const started = Date.now()
    this.calls += 1
    const attempt = work()
    this.inFlight.add(attempt)
    try {
      return await attempt
    } catch (error: any) {
      this.failures += 1
      const raw = scrub(String(error?.message ?? error))
      // Name the silence. "Aborted" and "nothing is listening" are different
      // operator actions, and reporting the first as the second has cost this
      // codebase an afternoon before.
      const why =
        error?.name === 'AbortError' || error?.name === 'TimeoutError'
          ? `the provisioner did not answer in time`
          : /fetch failed|ECONNREFUSED|Unable to connect/i.test(raw)
            ? `nothing is listening on ${this.config.endpoint} — is account-provisioner running?`
            : raw
      this.lastError = why
      return onError(why)
    } finally {
      this.inFlight.delete(attempt)
      this.lastMs = Date.now() - started
    }
  }

  /** Read a JSON body, bounded, and give back an object no matter what came back. */
  private async body(response: Response): Promise<Record<string, unknown>> {
    const text = (await response.text().catch(() => '')).slice(0, 20_000)
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      // Not JSON. The text may be an upstream stack trace, so it is scrubbed
      // before it is allowed to become an error message anywhere.
      return { error: scrub(text).slice(0, 500) }
    }
  }

  // ── the API ───────────────────────────────────────────────────────────────

  /**
   * Ask the provisioner to make an account for `provider`.
   *
   * **This creates a real account against a real external provider and spends
   * real quota.** Everything else on this row is a read.
   */
  async trigger(provider: string): Promise<TriggerResult> {
    const refuse = (error: string, status = 0): TriggerResult => ({
      ok: false,
      status,
      provider,
      triggered: false,
      error,
    })
    if (!this.config.enabled) return refuse('the provisioner-sdk row is switched off')
    if (!provider || !/^[A-Za-z0-9._-]+$/.test(provider)) {
      // The provider becomes a path segment. Anything that is not a plain name
      // could reach a different route entirely — `../accounts/x/provision` is
      // one `encodeURIComponent` away from being a very different request.
      return refuse(`"${provider}" is not a provider name`)
    }

    return this.track(
      async () => {
        const response = await fetch(`${this.config.endpoint}/provision/${encodeURIComponent(provider)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ async: this.config.async }),
          signal: AbortSignal.timeout(this.config.triggerTimeoutMs),
        })
        const bag = await this.body(response)

        // The allow-list. `email`, `apiKey` and `omnirouteId` are in that body
        // on the blocking path and they stop here — this projection is the only
        // route from the response to a value this row will hand back.
        const skipped = bag.skipped === true
        const result: TriggerResult = {
          ok: response.ok && !skipped,
          status: response.status,
          provider,
          triggered: bag.triggered === true,
          ...(str(bag, 'jobId') ? { jobId: str(bag, 'jobId')! } : {}),
          ...(skipped ? { skippedReason: str(bag, 'reason') ?? 'skipped' } : {}),
          ...(str(bag, 'streamUrl') ? { streamUrl: str(bag, 'streamUrl')! } : {}),
        }
        if (!result.ok) {
          const detail = str(bag, 'error') ?? str(bag, 'detail') ?? str(bag, 'message')
          result.error = scrub(detail ?? `the provisioner answered ${response.status}`).slice(0, 500)
          this.failures += 1
          this.lastError = result.error
        }
        return result
      },
      (why) => refuse(why),
    )
  }

  /** What the provisioner holds: account counts by provider, and what it thinks of OmniRoute. */
  async status(): Promise<ProvisionerStatus> {
    const empty = (error: string, status = 0): ProvisionerStatus => ({
      ok: false,
      status,
      accounts: { total: 0, active: 0, byProvider: {} },
      omniroute: { running: false, connections: 0 },
      providers: [],
      error,
    })
    if (!this.config.enabled) return empty('the provisioner-sdk row is switched off')

    return this.track(
      async () => {
        const response = await fetch(`${this.config.endpoint}/status`, {
          signal: AbortSignal.timeout(this.config.readTimeoutMs),
        })
        const bag = await this.body(response)
        if (!response.ok) return empty(scrub(str(bag, 'error') ?? `the provisioner answered ${response.status}`), response.status)

        // Counts, not accounts. `/status` publishes `byProvider` as a count map
        // and nothing more, but it is rebuilt here rather than spread, so that
        // a future field on that object cannot arrive by accident.
        const accounts = (bag.accounts ?? {}) as Record<string, unknown>
        const byProvider: Record<string, number> = {}
        for (const [key, value] of Object.entries((accounts.byProvider ?? {}) as Record<string, unknown>)) {
          if (typeof value === 'number' && Number.isFinite(value)) byProvider[key] = value
        }
        const omni = (bag.omniroute ?? {}) as Record<string, unknown>
        return {
          ok: true,
          status: response.status,
          accounts: {
            total: Number(accounts.total) || 0,
            active: Number(accounts.active) || 0,
            byProvider,
          },
          omniroute: {
            running: omni.running === true,
            connections: Number(omni.connections) || 0,
          },
          providers: Array.isArray(bag.providers) ? bag.providers.map(String) : [],
        }
      },
      (why) => empty(why),
    )
  }

  /** Which providers the provisioner knows how to sign up for. */
  async providers(): Promise<string[]> {
    if (!this.config.enabled) return []
    return this.track(
      async () => {
        const response = await fetch(`${this.config.endpoint}/providers`, {
          signal: AbortSignal.timeout(this.config.readTimeoutMs),
        })
        if (!response.ok) {
          this.failures += 1
          this.lastError = `the provisioner answered ${response.status}`
          return []
        }
        const bag = await this.body(response)
        return Array.isArray(bag.providers) ? bag.providers.map(String) : []
      },
      () => [],
    )
  }

  /** Is anything answering. The cheapest question there is. */
  async health(): Promise<{ ok: boolean; status: number; ms: number; error?: string }> {
    const started = Date.now()
    if (!this.config.enabled) return { ok: false, status: 0, ms: 0, error: 'the provisioner-sdk row is switched off' }
    return this.track(
      async () => {
        const response = await fetch(`${this.config.endpoint}/health`, {
          signal: AbortSignal.timeout(this.config.readTimeoutMs),
        })
        return { ok: response.ok, status: response.status, ms: Date.now() - started }
      },
      (why) => ({ ok: false, status: 0, ms: Date.now() - started, error: why }),
    )
  }

  /**
   * What this row has done, and optionally whether the far end is there.
   *
   * Named `report` rather than `status` because `status()` is the *provisioner's*
   * status. Two methods called status, one local and one remote, is the kind of
   * name collision that gets read wrong in an incident.
   */
  async report(probe = false) {
    const base = {
      enabled: this.config.enabled,
      endpoint: this.config.endpoint,
      async: this.config.async,
      calls: this.calls,
      failures: this.failures,
      inflight: this.inFlight.size,
      lastMs: this.lastMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
    if (!probe) return base
    return { ...base, probe: await this.health() }
  }
}

export default ProvisionerSdkService
