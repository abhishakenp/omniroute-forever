import type { RegistryEntry } from "../../shared.ts";

// sambanova — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.sambanova.ai/v1
export const sambanovaProvider: RegistryEntry = {
  id: "sambanova",
  alias: "sambanova",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.sambanova.ai/v1/chat/completions",
  modelsUrl: "https://api.sambanova.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
