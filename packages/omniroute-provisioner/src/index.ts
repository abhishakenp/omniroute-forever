/**
 * @omniroute/provisioner — asking for a new key when the pool runs dry.
 *
 * `src/sse/services/provisionerHook.ts` talks to a separate daemon that creates
 * fresh provider accounts. The gateway calls it at exactly one moment: when the
 * target iterator is exhausted, before deciding whether waiting is worth any
 * latency at all.
 *
 * That decision is the reason this is a row rather than a call. The hook's
 * `triggerProviderProvisioning()` returns *why* it did or did not act —
 * cooldown, blacklisted, already in flight, started — and the gateway is
 * required to distinguish "replenishment is under way, waiting may pay" from
 * "nothing will arrive, waiting is pure latency". Getting that wrong cost 30
 * seconds of held connection per request across 4,748 exhaustion events. The
 * seam keeps the distinction addressable: a deployment with no provisioner sets
 * `enabled: false` and gets an honest "nothing is coming" instead of a hook
 * that fails slowly.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  ensureProvisionerRunning,
  getInFlightProviders,
  isProvisionerAlive,
  isProvisioningUnderway,
  triggerAllProvidersProvisioning,
  triggerProviderProvisioning,
  waitForAnyProvisioning,
  waitForProviderProvisioning,
  type ProvisionTriggerResult,
} from '../../../src/sse/services/provisionerHook.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    provisioner: ProvisionerService
  }
}

export const name = 'omniroute-provisioner'

export interface Config {
  /**
   * Whether to call the provisioner at all.
   *
   * Off turns every trigger into a truthful `"disabled"`, which the gateway
   * reads as "nothing is coming" and so refuses immediately instead of sleeping
   * for a key that will never arrive.
   */
  enabled: boolean
  /** Check the daemon is up at boot, and say so. */
  probeAtBoot: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Call the provisioner daemon when the target pool is exhausted.'),
  probeAtBoot: Schema.boolean().default(false).description('Ping the provisioner once at boot and log whether it answered.'),
}) as unknown as Schema<Config>

/** `"disabled"` is ours; every other value comes from the hook. */
export type TriggerOutcome = ProvisionTriggerResult | 'disabled'

export class ProvisionerService extends Service {
  static provide = 'provisioner' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    if (!this.config.probeAtBoot) return
    const alive = await this.alive()
    console.log(`[omniroute-provisioner] daemon ${alive ? 'answered' : 'did not answer'}`)
  }

  async alive(): Promise<boolean> {
    if (!this.config.enabled) return false
    return isProvisionerAlive()
  }

  async ensureRunning(): Promise<boolean> {
    if (!this.config.enabled) return false
    return ensureProvisionerRunning()
  }

  /** Ask for a key for one provider. The return value says whether to wait. */
  trigger(provider: string): TriggerOutcome {
    if (!this.config.enabled) return 'disabled'
    return triggerProviderProvisioning(provider)
  }

  triggerAll(providers?: string[]): void {
    if (!this.config.enabled) return
    triggerAllProvidersProvisioning(providers)
  }

  /** Is this outcome one where waiting could actually produce a key? */
  underway(outcome: TriggerOutcome): boolean {
    if (outcome === 'disabled') return false
    return isProvisioningUnderway(outcome)
  }

  inFlight(): string[] {
    if (!this.config.enabled) return []
    return getInFlightProviders()
  }

  async waitFor(provider: string, timeoutMs?: number) {
    if (!this.config.enabled) return false
    return waitForProviderProvisioning(provider, timeoutMs as never)
  }

  async waitForAny(timeoutMs = 120_000) {
    if (!this.config.enabled) return false
    return waitForAnyProvisioning(timeoutMs)
  }
}

export default ProvisionerService
