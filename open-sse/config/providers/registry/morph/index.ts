import type { RegistryEntry } from "../../shared.ts";

// morph — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.morphllm.com/v1
export const morphProvider: RegistryEntry = {
  id: "morph",
  alias: "morph",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.morphllm.com/v1/chat/completions",
  modelsUrl: "https://api.morphllm.com/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
