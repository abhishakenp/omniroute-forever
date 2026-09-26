import type { RegistryEntry } from "../../shared.ts";

// scaleway — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.scaleway.ai/v1
export const scalewayProvider: RegistryEntry = {
  id: "scaleway",
  alias: "scaleway",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.scaleway.ai/v1/chat/completions",
  modelsUrl: "https://api.scaleway.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
