import type { RegistryEntry } from "../../shared.ts";

// ai21 — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.ai21.com/studio/v1
export const ai21Provider: RegistryEntry = {
  id: "ai21",
  alias: "ai21",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.ai21.com/studio/v1/chat/completions",
  modelsUrl: "https://api.ai21.com/studio/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
