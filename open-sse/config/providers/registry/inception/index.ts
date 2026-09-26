import type { RegistryEntry } from "../../shared.ts";

// inception — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.inceptionlabs.ai/v1
export const inceptionProvider: RegistryEntry = {
  id: "inception",
  alias: "inception",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.inceptionlabs.ai/v1/chat/completions",
  modelsUrl: "https://api.inceptionlabs.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
