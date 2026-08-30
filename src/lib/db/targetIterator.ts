/**
 * SQLite iterator for combo routing — one provider/model/apikey at a time.
 *
 * Replaces the in-memory target array pattern. Each call to `nextTarget()`
 * runs a single SQLite query that returns the next usable provider/model/
 * connection, filtered by:
 *   - is_active = 1
 *   - test_status NOT IN ('expired', 'error', 'unavailable', 'credits_exhausted')
 *   - rate_limited_until IS NULL OR rate_limited_until < now
 *   - provider has synced models
 *
 * The caller tries the target, and on failure calls `markFailed()` which
 * updates SQLite directly. The next `nextTarget()` call skips it.
 *
 * Zero in-memory state. Zero caching. One row at a time.
 */

import { getDbInstance } from "./core.ts";
import { decryptConnectionFields } from "./encryption.ts";
import { getProviderRegistry } from "../../../open-sse/services/autoCombo/providerRegistryAccessor.ts";

export interface TargetRow {
  connectionId: string;
  provider: string;
  modelId: string;
  modelStr: string; // "provider/model"
  apiKey: string | null;
  authType: string | null;
  defaultModel: string | null;
  priority: number;
}

// Track which connections we've already tried in this request so we don't retry them.
// This is request-scoped (one iterator instance per request), not global state.
export class TargetIterator {
  private triedConnectionIds = new Set<string>();
  private triedProviderModels = new Set<string>(); // "provider:modelId"
  private triedNoAuth = false;
  private db = getDbInstance();
  private freeProvidersOnly: boolean;
  private excludedProviders: Set<string>;
  private specificProvider: string | null;
  private specificModel: string | null;

  constructor(opts: {
    freeProvidersOnly?: boolean;
    excludedProviders?: Set<string>;
    specificProvider?: string;
    specificModel?: string;
  } = {}) {
    this.freeProvidersOnly = opts.freeProvidersOnly ?? false;
    this.excludedProviders = opts.excludedProviders ?? new Set();
    this.specificProvider = opts.specificProvider ?? null;
    this.specificModel = opts.specificModel ?? null;
  }

  /**
   * Get the next available target. Returns null when exhausted.
   * Each call is a single SQLite query — no caching, no in-memory arrays.
   */
  nextTarget(): TargetRow | null {
    // Get active connections that haven't been tried yet, ordered by priority.
    // Filter by specific provider when set (for direct provider/model requests).
    const now = new Date().toISOString();
    const providerFilter = this.specificProvider
      ? `AND provider = ?`
      : "";
    // Params order: [specificProvider?, now]
    const params = this.specificProvider ? [this.specificProvider, now] : [now];
    const rows = this.db
      .prepare(
        `SELECT id, provider, api_key, auth_type, default_model, priority, test_status, rate_limited_until
         FROM provider_connections
         WHERE is_active = 1
           ${providerFilter}
           AND (test_status IS NULL OR test_status NOT IN ('expired', 'error', 'unavailable', 'credits_exhausted'))
           AND (rate_limited_until IS NULL OR rate_limited_until < ?)
         ORDER BY priority DESC, last_used_at ASC
         LIMIT 200`
      )
      .all(...params) as Array<{
        id: string;
        provider: string;
        api_key: string | null;
        auth_type: string | null;
        default_model: string | null;
        priority: number;
      }>;

    for (const conn of rows) {
      if (this.triedConnectionIds.has(conn.id)) continue;
      if (this.excludedProviders.has(conn.provider)) continue;

      // Get synced models for this connection's provider
      const modelRows = this.db
        .prepare(
          `SELECT value FROM key_value
           WHERE namespace = 'syncedAvailableModels'
             AND (key = ? OR key LIKE ?)
           LIMIT 1`
        )
        .get(conn.provider, `${conn.provider}:%`) as { value: string } | undefined;

      let modelIds: string[] = [];
      if (modelRows?.value) {
        try {
          const parsed = JSON.parse(modelRows.value);
          if (Array.isArray(parsed)) {
            modelIds = parsed
              .map((m: { id?: string }) => (typeof m?.id === "string" ? m.id : ""))
              .filter(Boolean)
              .slice(0, 5); // cap models per provider
          }
        } catch {
          // ignore JSON parse errors
        }
      }

      // Fall back to registry models for no-auth providers (opencode, auggie, etc.)
      if (modelIds.length === 0) {
        const registry = getProviderRegistry();
        const entry = registry[conn.provider];
        if (entry?.models && Array.isArray(entry.models)) {
          modelIds = entry.models
            .map((m: { id?: string }) => (typeof m?.id === "string" ? m.id : ""))
            .filter(Boolean)
            .slice(0, 3);
        }
      }

      // If a specific model is requested, filter to only that model
      if (this.specificModel) {
        modelIds = modelIds.filter((m) => m === this.specificModel);
        if (modelIds.length === 0) modelIds = [this.specificModel]; // trust the user
      }

      // Fall back to default_model if still no models
      if (modelIds.length === 0 && conn.default_model) {
        modelIds = [conn.default_model];
      }

      for (const modelId of modelIds) {
        const key = `${conn.provider}:${modelId}`;
        if (this.triedProviderModels.has(key)) continue;

        // Found an untried provider/model/connection — return it
        this.triedConnectionIds.add(conn.id);
        this.triedProviderModels.add(key);

        // Decrypt the API key before returning
        const decrypted = decryptConnectionFields({
          apiKey: conn.api_key,
          accessToken: undefined,
          refreshToken: undefined,
          idToken: undefined,
        });

        return {
          connectionId: conn.id,
          provider: conn.provider,
          modelId,
          modelStr: `${conn.provider}/${modelId}`,
          apiKey: decrypted.apiKey ?? null,
          authType: conn.auth_type,
          defaultModel: conn.default_model,
          priority: conn.priority,
        };
      }
    }

    // No more connection-based targets — try no-auth providers from the registry.
    // Skip this for direct provider/model requests (specificProvider set).
    if (!this.specificProvider) {
      const registry = getProviderRegistry();
      for (const [providerId, entry] of Object.entries(registry)) {
        if (this.excludedProviders.has(providerId)) continue;
        if (entry.authType !== "none" && entry.noAuth !== true) continue;
        if (!entry.models || !Array.isArray(entry.models)) continue;

        for (const model of entry.models.slice(0, 3)) {
          const modelId = typeof model?.id === "string" ? model.id : "";
          if (!modelId) continue;
          const key = `${providerId}:${modelId}`;
          if (this.triedProviderModels.has(key)) continue;
          this.triedProviderModels.add(key);

          return {
            connectionId: `noauth-${providerId}`,
            provider: providerId,
            modelId,
            modelStr: `${providerId}/${modelId}`,
            apiKey: null,
            authType: "none",
            defaultModel: null,
            priority: -1, // no-auth providers are lower priority
          };
        }
      }
    }

    return null; // exhausted
  }

  /**
   * Mark a target as failed (rate-limited or errored).
   * Updates SQLite directly so the next nextTarget() call skips it.
   */
  markFailed(connectionId: string, status: number, cooldownMs: number = 60_000): void {
    const retryAfter = new Date(Date.now() + cooldownMs).toISOString();
    if (status === 429) {
      this.db
        .prepare(
          `UPDATE provider_connections
           SET rate_limited_until = ?, last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(retryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if ([401, 403].includes(status)) {
      this.db
        .prepare(
          `UPDATE provider_connections
           SET test_status = 'error', last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(`HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if (status === 402) {
      // Insufficient credits — mark as credits_exhausted (provisioner will refresh)
      this.db
        .prepare(
          `UPDATE provider_connections
           SET test_status = 'credits_exhausted', last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(`HTTP ${status}`, new Date().toISOString(), connectionId);
    } else if ([500, 502, 503, 504].includes(status)) {
      // Short cooldown for server errors — might be transient
      this.db
        .prepare(
          `UPDATE provider_connections
           SET rate_limited_until = ?, last_error = ?, last_error_at = ?
           WHERE id = ?`
        )
        .run(retryAfter, `HTTP ${status}`, new Date().toISOString(), connectionId);
    }
    // 400 = model-specific error, don't mark connection — just skip this model
  }

  /**
   * Mark a target as succeeded — update last_used_at for LKGP-style ordering.
   */
  markSucceeded(connectionId: string): void {
    this.db
      .prepare(
        `UPDATE provider_connections SET last_used_at = ? WHERE id = ?`
      )
      .run(new Date().toISOString(), connectionId);
  }

  /**
   * Have we tried all available targets?
   */
  get isExhausted(): boolean {
    return this.triedConnectionIds.size > 0 && this.nextTarget() === null;
  }

  /**
   * Which providers have we tried?
   */
  get triedProviders(): Set<string> {
    const providers = new Set<string>();
    // Extract from triedProviderModels which is "provider:modelId"
    for (const key of this.triedProviderModels) {
      const provider = key.split(":")[0];
      if (provider) providers.add(provider);
    }
    return providers;
  }
}
