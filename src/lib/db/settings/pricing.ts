/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { getDbInstance } from "../core";
import { backupDbFile } from "../backup";
import { invalidateDbCache, getCachedPricing } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { type JsonRecord, toRecord } from "./shared";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

function readPricingNamespace(
  db: ReturnType<typeof getDbInstance>,
  namespace: string
): PricingByProvider {
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = ?").all(namespace);
  const pricing: PricingByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;

    try {
      pricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
    } catch {
      // Corrupted data — skip silently, fallback to lower layers
    }
  }

  return pricing;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

async function getPricingLayers() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  return {
    defaults: getDefaultPricing(),
    litellm: readPricingNamespace(db, "pricing_synced"),
    modelsDev: readPricingNamespace(db, "models_dev_pricing"),
    user: readPricingNamespace(db, "pricing"),
  };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

// Pre-computed lowercase lookup map for O(1) pricing access.
// Built once per pricing cache entry (30s TTL) instead of doing case-insensitive
// linear scans on every getPricingForModel call (876+ calls per request).
let _lowercasePricingMap: Map<string, Map<string, JsonRecord>> | null = null;
let _lowercasePricingSource: PricingByProvider | null = null;

function getLowercasePricingMap(pricing: PricingByProvider): Map<string, Map<string, JsonRecord>> {
  // Rebuild only if the source object changed (cache hit = skip rebuild)
  if (_lowercasePricingMap && _lowercasePricingSource === pricing) return _lowercasePricingMap;

  const providerMap = new Map<string, Map<string, JsonRecord>>();
  for (const [providerKey, models] of Object.entries(pricing)) {
    const lowerProvider = providerKey.toLowerCase();
    const modelMap = new Map<string, JsonRecord>();
    if (models && typeof models === "object") {
      for (const [modelKey, modelData] of Object.entries(models)) {
        modelMap.set(modelKey.toLowerCase(), modelData as JsonRecord);
      }
    }
    providerMap.set(lowerProvider, modelMap);
  }

  // Also add alias mappings so lookup is O(1) for aliases too
  for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
    if (typeof alias === "string") {
      const lowerId = id.toLowerCase();
      const lowerAlias = alias.toLowerCase();
      if (providerMap.has(lowerAlias) && !providerMap.has(lowerId)) {
        providerMap.set(lowerId, providerMap.get(lowerAlias)!);
      }
      if (providerMap.has(lowerId) && !providerMap.has(lowerAlias)) {
        providerMap.set(lowerAlias, providerMap.get(lowerId)!);
      }
    }
  }

  _lowercasePricingMap = providerMap;
  _lowercasePricingSource = pricing;
  return providerMap;
}

export async function getPricingForModel(provider: string, model: string) {
  // Hot path: buildAutoCandidates calls this once per candidate (876+ times).
  // Use the cached singleton pricing map with O(1) lowercase lookup.
  const pricing = (await getCachedPricing()) as PricingByProvider;
  const providerMap = getLowercasePricingMap(pricing);

  const pLower = (provider || "").toLowerCase();
  let modelMap = providerMap.get(pLower);

  // Try -cn variant (e.g. "groq-cn" → "groq")
  if (!modelMap) {
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) modelMap = providerMap.get(np);
  }

  if (!modelMap) return null;

  const mLower = (model || "").toLowerCase();
  let modelPricing = modelMap.get(mLower);

  // Try dot→hyphen variant (e.g. "gpt-4.1" → "gpt-4-1")
  if (!modelPricing) {
    const hyphenModel = mLower.replace(/\./g, "-");
    if (hyphenModel !== mLower) modelPricing = modelMap.get(hyphenModel);
  }

  return modelPricing || null;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  invalidateDbCache("pricing"); // Bust the pricing read cache
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  return {};
}
