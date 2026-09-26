import type { RegistryEntry } from "../../shared.ts";

// requesty — OpenAI-compatible, free tier with signup credits.
// Base URL: https://router.requesty.ai/v1
export const requestyProvider: RegistryEntry = {
  id: "requesty",
  alias: "requesty",
  format: "openai",
  executor: "default",
  baseUrl: "https://router.requesty.ai/v1/chat/completions",
  modelsUrl: "https://router.requesty.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
