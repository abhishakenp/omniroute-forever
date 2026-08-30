import { getDbInstance } from "@/lib/db/core.ts";
import { getProviderRegistry } from "@omniroute/open-sse/services/autoCombo/providerRegistryAccessor.ts";

/**
 * Simple /v1/models endpoint — queries SQLite directly, no combo engine.
 * Returns all active provider models + auto/* variants.
 */

export async function GET() {
  const db = getDbInstance();
  const registry = getProviderRegistry();
  const models: Array<{ id: string; object: string; created: number; owned_by: string }> = [];

  // Add auto/* variants
  const autoVariants = ["auto/best-free", "auto/best-coding", "auto/best-reasoning", "auto/best-fast", "auto/best-chat"];
  for (const id of autoVariants) {
    models.push({ id, object: "model", created: Date.now(), owned_by: "omniroute" });
  }

  // Add models from active connections
  const connections = db
    .prepare(
      `SELECT DISTINCT provider FROM provider_connections WHERE is_active = 1`
    )
    .all() as Array<{ provider: string }>;

  for (const { provider } of connections) {
    // Get synced models
    const modelRows = db
      .prepare(
        `SELECT value FROM key_value
         WHERE namespace = 'syncedAvailableModels'
           AND (key = ? OR key LIKE ?)
         LIMIT 1`
      )
      .get(provider, `${provider}:%`) as { value: string } | undefined;

    if (modelRows?.value) {
      try {
        const parsed = JSON.parse(modelRows.value);
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (typeof m?.id === "string") {
              models.push({
                id: `${provider}/${m.id}`,
                object: "model",
                created: Date.now(),
                owned_by: provider,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Fall back to registry models
    const entry = registry[provider];
    if (entry?.models && Array.isArray(entry.models)) {
      for (const m of entry.models) {
        if (typeof m?.id === "string") {
          models.push({
            id: `${provider}/${m.id}`,
            object: "model",
            created: Date.now(),
            owned_by: provider,
          });
        }
      }
    }
  }

  return Response.json({ object: "list", data: models });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function HEAD() {
  return new Response(null, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
