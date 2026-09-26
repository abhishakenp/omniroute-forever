import type { RegistryEntry } from "../../shared.ts";

// nebius — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.tokenfactory.nebius.com/v1
export const nebiusProvider: RegistryEntry = {
  id: "nebius",
  alias: "nebius",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.tokenfactory.nebius.com/v1/chat/completions",
  modelsUrl: "https://api.tokenfactory.nebius.com/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
