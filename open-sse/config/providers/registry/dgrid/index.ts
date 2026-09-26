import type { RegistryEntry } from "../../shared.ts";

// dgrid — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.dgrid.ai/v1
export const dgridProvider: RegistryEntry = {
  id: "dgrid",
  alias: "dgrid",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.dgrid.ai/v1/chat/completions",
  modelsUrl: "https://api.dgrid.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
