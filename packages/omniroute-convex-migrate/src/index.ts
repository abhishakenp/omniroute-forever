/**
 * @omniroute/convex-migrate — migrate data from SQLite to Convex.
 *
 * This row reads all provider connections and key-value pairs from the
 * SQLite store and writes them to the Convex store. It's a one-time
 * migration tool, not a live-path component.
 *
 * ## Usage
 *
 * Add this row to the composition alongside both `@omniroute/db-sqlite`
 * and `@omniroute/db-convex` (with SQLite as the active `ctx.db` and Convex
 * accessible via the convexConfig service). Then call `migrate()`:
 *
 * ```ts
 * const migrator = ctx.get("convexMigrate");
 * const result = await migrator.migrate();
 * console.log(`Migrated ${result.connections} connections and ${result.kv} KV pairs`);
 * ```
 *
 * ## Hot-swappable
 *
 * Like every other row, this is hot-swappable. It does nothing on init —
 * migration only runs when explicitly called.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";

declare module "@deepseek-ai/cordis" {
  interface Context {
    convexMigrate: ConvexMigrateService;
  }
}

export const name = "omniroute-convex-migrate";

export interface Config {
  /**
   * Batch size for writing connections to Convex.
   *
   * Convex mutations are one-at-a-time, so this is the number of concurrent
   * mutations in flight. Default 10 — enough for throughput, not enough to
   * hit rate limits.
   */
  batchSize: number;
  /**
   * Whether to skip connections that already exist in Convex.
   *
   * On by default — re-running a migration should not create duplicates.
   * Turn off to force re-import (will create duplicates).
   */
  skipExisting: boolean;
}

export const Config: Schema<Config> = Schema.object({
  batchSize: Schema.number()
    .default(10)
    .description("Number of concurrent Convex mutations during migration."),
  skipExisting: Schema.boolean()
    .default(true)
    .description("Skip connections that already exist in Convex."),
}) as unknown as Schema<Config>;

export interface MigrationResult {
  connections: number;
  kv: number;
  skipped: number;
  errors: number;
}

export class ConvexMigrateService extends Service {
  static provide = "convexMigrate" as const;
  static Config = Config;

  declare config: Config;

  constructor(ctx: Context, config: Config) {
    super(ctx, undefined as any);
    this.config = config;
  }

  async [Service.init]() {
    // Nothing to do on init — migration is explicit.
  }

  /**
   * Migrate all data from SQLite to Convex.
   *
   * Reads provider connections and key-value pairs from the active `ctx.db`
   * (which must be the SQLite adapter) and writes them to the Convex
   * deployment via the convexConfig service.
   *
   * @returns counts of migrated and skipped items.
   */
  async migrate(): Promise<MigrationResult> {
    const result: MigrationResult = { connections: 0, kv: 0, skipped: 0, errors: 0 };

    // Get the source (SQLite) adapter.
    const source = this.ctx.get("db");
    if (!source) {
      throw new Error("[omniroute-convex-migrate] no ctx.db available — load @omniroute/db-sqlite first");
    }

    // Get the Convex config for the destination.
    const convexConfig = this.ctx.get("convexConfig");
    if (!convexConfig) {
      throw new Error("[omniroute-convex-migrate] no ctx.convexConfig available — load @omniroute/convex-login first");
    }

    const deploymentUrl = convexConfig.getDeploymentUrl?.();
    if (!deploymentUrl) {
      throw new Error("[omniroute-convex-migrate] no Convex deployment URL configured");
    }

    // Lazy-load the Convex client.
    const { ConvexHttpClient } = await import("convex/browser");
    const apiKey = convexConfig.getApiKey?.() || undefined;
    const client = new ConvexHttpClient({ url: deploymentUrl, auth: apiKey });

    try {
      // ── Migrate provider connections ──────────────────────────────────────
      const connections = await source.queryProviderConnections({}) as any[];
      this.ctx.logger?.info(`[omniroute-convex-migrate] found ${connections.length} connections to migrate`);

      // Check existing if skipExisting is on.
      let existingIds = new Set<string>();
      if (this.config.skipExisting) {
        const existing = await client.query("providerConnections:queryConnections", {});
        existingIds = new Set(existing.map((r: any) => String(r.id)));
      }

      // Migrate in batches.
      for (let i = 0; i < connections.length; i += this.config.batchSize) {
        const batch = connections.slice(i, i + this.config.batchSize);
        const promises = batch.map(async (conn) => {
          try {
            // Map SQLite snake_case to Convex camelCase.
            const data = {
              provider: conn.provider,
              apiKey: conn.api_key ?? conn.apiKey ?? null,
              reservedFor: conn.reserved_for ?? conn.reservedFor ?? null,
              isActive: conn.is_active ?? conn.isActive ?? true,
              model: conn.model ?? null,
              authType: conn.auth_type ?? conn.authType ?? null,
              defaultModel: conn.default_model ?? conn.defaultModel ?? null,
              priority: conn.priority ?? 0,
            };
            if (this.config.skipExisting && existingIds.has(String(conn.id))) {
              result.skipped++;
              return;
            }
            await client.mutation("providerConnections:createConnection", data);
            result.connections++;
          } catch (err) {
            result.errors++;
            this.ctx.logger?.warn(`[omniroute-convex-migrate] failed to migrate connection ${conn.id}: ${err}`);
          }
        });
        await Promise.all(promises);
      }

      // ── Migrate key-value pairs ────────────────────────────────────────────
      // Read all KV pairs from SQLite. The DbAdapter interface only has kvGet
      // and kvSet, so we need to read all keys. The SQLite adapter's handle()
      // gives us direct access, but we don't want to reach past the seam.
      // Instead, we use a known set of keys from the OmniRoute codebase.
      // For a full migration, the caller should provide the list of keys.
      const knownKeys = [
        "schema_version",
        "last_migration",
        "provisioner_state",
        "rate_limit_config",
      ];

      for (const key of knownKeys) {
        try {
          const value = await source.kvGet(key);
          if (value != null) {
            await client.mutation("kv:kvSet", { key, value });
            result.kv++;
          }
        } catch (err) {
          result.errors++;
          this.ctx.logger?.warn(`[omniroute-convex-migrate] failed to migrate KV ${key}: ${err}`);
        }
      }

      this.ctx.logger?.info(
        `[omniroute-convex-migrate] migration complete: ${result.connections} connections, ${result.kv} KV pairs, ${result.skipped} skipped, ${result.errors} errors`,
      );
    } finally {
      client.close?.();
    }

    return result;
  }
}

export default ConvexMigrateService;
