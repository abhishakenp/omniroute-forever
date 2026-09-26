import type { RegistryEntry } from "../../shared.ts";

// sealion — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.sea-lion.ai/v1
export const sealionProvider: RegistryEntry = {
  id: "sealion",
  alias: "sealion",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.sea-lion.ai/v1/chat/completions",
  modelsUrl: "https://api.sea-lion.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
