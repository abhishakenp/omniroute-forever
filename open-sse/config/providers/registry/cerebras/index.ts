import type { RegistryEntry } from "../../shared.ts";

// cerebras — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.cerebras.ai/v1
export const cerebrasProvider: RegistryEntry = {
  id: "cerebras",
  alias: "cerebras",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.cerebras.ai/v1/chat/completions",
  modelsUrl: "https://api.cerebras.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
