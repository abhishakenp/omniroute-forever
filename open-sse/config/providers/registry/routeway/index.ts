import type { RegistryEntry } from "../../shared.ts";

// routeway — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.routeway.ai/v1
export const routewayProvider: RegistryEntry = {
  id: "routeway",
  alias: "routeway",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.routeway.ai/v1/chat/completions",
  modelsUrl: "https://api.routeway.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
