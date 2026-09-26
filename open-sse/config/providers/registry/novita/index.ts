import type { RegistryEntry } from "../../shared.ts";

// novita — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.novita.ai/openai/v1
export const novitaProvider: RegistryEntry = {
  id: "novita",
  alias: "novita",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.novita.ai/openai/v1/chat/completions",
  modelsUrl: "https://api.novita.ai/openai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
