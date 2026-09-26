import type { RegistryEntry } from "../../shared.ts";

// pioneer — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.pioneer.ai/v1
export const pioneerProvider: RegistryEntry = {
  id: "pioneer",
  alias: "pioneer",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.pioneer.ai/v1/chat/completions",
  modelsUrl: "https://api.pioneer.ai/v1/models",
  authType: "apikey",
  authHeader: "x-api-key",
  passthroughModels: true,
  models: [],
};
