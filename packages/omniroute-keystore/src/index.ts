/**
 * @omniroute/keystore — credentials at rest.
 *
 * `src/lib/db/encryption.ts` is AES-256-GCM over a key read from
 * `STORAGE_ENCRYPTION_KEY`, plus the legacy-format migration that lets a row
 * written by an older OmniRoute still decrypt. This row does not reimplement
 * any of that; it imports it, and adds the two things the module cannot say
 * about itself:
 *
 * 1. **Whether encryption is actually on.** `isEncryptionEnabled()` is a
 *    function nobody calls at boot, so a deployment that lost its key found out
 *    when the first request tried to use a connection and got ciphertext where
 *    an API key should be. Here it is checked once, out loud, at load.
 * 2. **A name to reach it by.** `ctx.keystore` is what the provisioner and the
 *    gateway use, which is what makes a hardware-backed or KMS keystore a
 *    different row rather than a different codebase.
 *
 * There is deliberately no method here that returns a plaintext secret in bulk.
 * Decryption is per-connection and on the path that is about to spend the
 * credential, so a mistake leaks one key rather than 718.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  decrypt,
  decryptConnectionFields,
  encrypt,
  encryptConnectionFields,
  isEncryptionEnabled,
  looksEncrypted,
  migrateLegacyEncryptedString,
  type ConnectionFields,
} from '../../../src/lib/db/encryption.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    keystore: KeystoreService
  }
}

export const name = 'omniroute-keystore'

export interface Config {
  /**
   * Refuse to load when no encryption key is configured.
   *
   * Off by default: a fresh install has no key yet and must still be able to
   * boot far enough for someone to set one. On for anything holding real keys.
   */
  requireKey: boolean
}

export const Config: Schema<Config> = Schema.object({
  requireKey: Schema.boolean()
    .default(false)
    .description('Throw at boot when STORAGE_ENCRYPTION_KEY is absent, instead of warning.'),
}) as unknown as Schema<Config>

export class KeystoreService extends Service {
  static provide = 'keystore' as const
  static Config = Config

  declare config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any)
    this.config = config
  }

  async [Service.init]() {
    if (this.enabled()) return
    const message = '[omniroute-keystore] encryption is OFF — credentials are stored in plaintext'
    if (this.config.requireKey) throw new Error(message)
    console.warn(message)
  }

  /** Whether a usable key is configured right now. */
  enabled(): boolean {
    return isEncryptionEnabled()
  }

  encrypt(plaintext: string | null | undefined) {
    return encrypt(plaintext)
  }

  decrypt(ciphertext: string | null | undefined) {
    return decrypt(ciphertext)
  }

  /** Does this value already look like our ciphertext? Cheap, no key needed. */
  looksEncrypted(value: unknown): boolean {
    return looksEncrypted(value)
  }

  sealConnection<T extends ConnectionFields | null | undefined>(conn: T): T {
    return encryptConnectionFields(conn)
  }

  openConnection<T extends ConnectionFields | null | undefined>(row: T): T {
    return decryptConnectionFields(row)
  }

  /** Read a value written by an older format, and say which format it was. */
  migrateLegacy(ciphertext: string | null | undefined) {
    return migrateLegacyEncryptedString(ciphertext)
  }
}

export default KeystoreService
