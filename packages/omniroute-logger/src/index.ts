/**
 * @omniroute/logger — what went wrong, said once and said the same way.
 *
 * Three modules, one row, because they answer one question between them:
 *
 * - `failureDomain.ts` is the refusal taxonomy. Its whole reason to exist is
 *   that OmniRoute refusing to *start* work (queue full, queue timeout, client
 *   gone) used to be byte-identical to an upstream having *failed* — both 503
 *   with `Retry-After: 5` — so a caller could not tell "back off, I am busy"
 *   from "every provider is down". Anything that builds a refusal must go
 *   through here or that distinction dies again.
 * - `open-sse/utils/error.ts` is the OpenAI-shaped error body.
 * - `stdoutLogRotation.ts` is why `omniroute.log` is not 54 MB. It has to be
 *   periodic, not startup-only: a KeepAlive daemon that checks once never
 *   checks again.
 *
 * The rotation timer is the only live thing here, and it is held by
 * `ctx.effect()` — so a reload of this row stops the old timer instead of
 * leaving two of them racing on the same file.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  buildFailureBody,
  failureDomainOf,
  failureHeaders,
  failureResponse,
  statusForFailure,
  type FailureCode,
  type FailureDomain,
} from '../../../src/server/headless/failureDomain.ts'
import { errorResponse } from '../../../open-sse/utils/error.ts'
import * as log from '../../../src/sse/utils/logger.ts'
import {
  resolveStdoutLogPath,
  startStdoutLogRotation,
  stopStdoutLogRotation,
} from '../../../src/lib/stdoutLogRotation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    omniLog: LoggerService
  }
}

export const name = 'omniroute-logger'

export interface Config {
  /** Watch and rotate this process's own stdout log. */
  rotateStdout: boolean
  /**
   * Directory whose `logs/` holds the stdout log.
   *
   * Empty means `DATA_DIR`, else `~/.omniroute` — matching the store, because a
   * second instance pointed at a copy of the database should not be writing
   * into the live instance's log.
   */
  dataDir: string
}

export const Config: Schema<Config> = Schema.object({
  rotateStdout: Schema.boolean().default(true).description("Rotate this process's stdout log periodically."),
  dataDir: Schema.string().default('').description('Directory holding logs/. Empty = DATA_DIR, else ~/.omniroute.'),
}) as unknown as Schema<Config>

export class LoggerService extends Service {
  static provide = 'omniLog' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    if (!this.config.rotateStdout) return
    const dir = this.config.dataDir || process.env.DATA_DIR || `${process.env.HOME ?? ''}/.omniroute`
    try {
      const path = resolveStdoutLogPath(dir)
      if (!path) {
        console.log('[omniroute-logger] no stdout log to watch')
        return
      }
      startStdoutLogRotation(path)
      console.log(`[omniroute-logger] stdout rotation armed for ${path}`)
      this.ctx.effect(() => () => stopStdoutLogRotation(), 'logger.rotation')
    } catch (err) {
      console.warn('[omniroute-logger] rotation setup failed:', err)
    }
  }

  // ── the refusal contract ──────────────────────────────────────────────────

  /** The one way to build a refusal. Never hand-roll a 503. */
  refuse(code: FailureCode, message: string): Response {
    return failureResponse(code, message)
  }

  /** Was this our refusal to start, or an upstream's failure to answer? */
  domainOf(code: FailureCode): FailureDomain {
    return failureDomainOf(code)
  }

  statusFor(code: FailureCode): number {
    return statusForFailure(code)
  }

  bodyFor(code: FailureCode, message: string) {
    return buildFailureBody(code, message)
  }

  headersFor(code: FailureCode) {
    return failureHeaders(code)
  }

  /** An OpenAI-shaped error body, for the paths that are not refusals. */
  error(...args: Parameters<typeof errorResponse>) {
    return errorResponse(...args)
  }

  // ── the log ───────────────────────────────────────────────────────────────

  debug(tag: string, message: string, data?: unknown) { log.debug(tag, message, data) }
  info(tag: string, message: string, data?: unknown) { log.info(tag, message, data) }
  warn(tag: string, message: string, data?: unknown) { log.warn(tag, message, data) }
  error_(tag: string, message: string, data?: unknown) { log.error(tag, message, data) }
}

export default LoggerService
