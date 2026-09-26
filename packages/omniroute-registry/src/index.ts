/**
 * @omniroute/registry — what a provider *is*.
 *
 * `open-sse/config/providers/registry/<name>/index.ts` is one file per
 * provider: base URL, auth style, which models it serves, which OpenAI
 * parameters it will reject, whether its catalogue is authoritative. That is a
 * body of knowledge, not logic, and it changes when a provider changes rather
 * than when OmniRoute does — which is exactly the argument for it being its own
 * row: an added provider is a data edit and a reload, not a redeploy.
 *
 * `getProviderRegistry()` (the accessor the gateway calls) is a nine-line file
 * that memoises `generateLegacyProviders()`. It is imported here rather than
 * re-derived so that the gateway and this row agree by construction.
 *
 * Nothing in this row is live: no timers, no handles, no state that outlives a
 * call. That is why it has no disposer — a row with nothing to release should
 * not pretend to release something.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { getProviderRegistry } from '../../../open-sse/services/autoCombo/providerRegistryAccessor.ts'
import {
  generateAliasMap,
  generateModels,
  getProviderCategory,
  getRegisteredProviders,
  getRegistryEntry,
  getUnsupportedParams,
  isLocalProvider,
  getPassthroughProviders,
  providerUsesAuthoritativeLiveCatalog,
  requiresPlainStringContent,
} from '../../../open-sse/config/providerRegistry.ts'
import type { RegistryEntry } from '../../../open-sse/config/providers/shared.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    registry: RegistryService
  }
}

export const name = 'omniroute-registry'

export interface Config {
  /** Say how many providers and models loaded, once, at boot. */
  announce: boolean
}

export const Config: Schema<Config> = Schema.object({
  announce: Schema.boolean().default(true).description('Log the provider and model counts at boot.'),
}) as unknown as Schema<Config>

export class RegistryService extends Service {
  static provide = 'registry' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    if (!this.config.announce) return
    const providers = this.providers()
    const models = Object.values(this.models()).reduce((n, list) => n + list.length, 0)
    console.log(`[omniroute-registry] ${providers.length} providers, ${models} models`)
  }

  /** The memoised legacy-shaped registry the gateway iterates. */
  all() {
    return getProviderRegistry()
  }

  providers(): string[] {
    return getRegisteredProviders()
  }

  entry(provider: string): RegistryEntry | null {
    return getRegistryEntry(provider)
  }

  models() {
    return generateModels()
  }

  aliases() {
    return generateAliasMap()
  }

  /** Parameters this provider will reject — strip them before sending. */
  unsupportedParams(provider: string, modelId: string): readonly string[] {
    return getUnsupportedParams(provider, modelId)
  }

  requiresPlainStringContent(provider: string): boolean {
    return requiresPlainStringContent(provider)
  }

  usesAuthoritativeCatalog(provider: string): boolean {
    return providerUsesAuthoritativeLiveCatalog(provider)
  }

  category(provider: string): 'oauth' | 'apikey' {
    return getProviderCategory(provider)
  }

  passthrough(): Set<string> {
    return getPassthroughProviders()
  }

  isLocal(baseUrl?: string | null): boolean {
    return isLocalProvider(baseUrl)
  }
}

export default RegistryService
