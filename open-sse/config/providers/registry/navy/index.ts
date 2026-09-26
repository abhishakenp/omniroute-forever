import type { RegistryEntry } from "../../shared.ts";

// navy — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.navy/v1
export const navyProvider: RegistryEntry = {
  id: "navy",
  alias: "navy",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.navy/v1/chat/completions",
  modelsUrl: "https://api.navy/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
