/**
 * @omniroute/executor — the part that actually speaks to an upstream.
 *
 * `open-sse/executors/index.ts` is a factory: given a provider name it returns
 * either that provider's specialised executor (a web scraper, a local CLI
 * bridge, an OAuth-shaped client) or the default HTTP one. Behind it sit
 * `base.ts` (1,680 lines of retry, header, and stream handling) and
 * `default.ts` (1,118 more).
 *
 * This row deliberately adds almost nothing. There is no state to own here —
 * the executors are stateless per call — so the value of a row is the seam, not
 * the wrapper: `ctx.executor` is what a future in-process or mock executor
 * replaces, and `hasSpecialized()` is what lets the gateway report *why* a
 * provider behaved unusually without importing the factory itself.
 *
 * The one thing that would justify code here is the `import()` — the factory
 * lazily imports each specialised executor on first use, so nothing but the
 * default one is loaded on a boot that never touches a scraper. Keeping that
 * lazy is the reason this file does not eagerly enumerate them.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { getExecutor, hasSpecializedExecutor } from '../../../open-sse/executors/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    executor: ExecutorService
  }
}

export const name = 'omniroute-executor'

export interface Config {
  /**
   * Providers whose specialised executor is not to be used, falling back to the
   * default HTTP one.
   *
   * A scraper that upstream has just broken is a config edit and a reload away
   * from being bypassed, rather than a code change.
   */
  disableSpecialized: string[]
}

export const Config: Schema<Config> = Schema.object({
  disableSpecialized: Schema.array(Schema.string())
    .default([])
    .description('Providers to route through the default HTTP executor even if a specialised one exists.'),
}) as unknown as Schema<Config>

export class ExecutorService extends Service {
  static provide = 'executor' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  /** The executor for this provider, honouring `disableSpecialized`. */
  for(provider: string) {
    if (this.config.disableSpecialized.includes(provider)) return getExecutor('__default__')
    return getExecutor(provider)
  }

  /** Whether this provider has anything other than the default HTTP path. */
  hasSpecialized(provider: string): boolean {
    if (this.config.disableSpecialized.includes(provider)) return false
    return hasSpecializedExecutor(provider)
  }
}

export default ExecutorService
