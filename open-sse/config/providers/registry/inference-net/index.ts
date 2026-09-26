import type { RegistryEntry } from "../../shared.ts";

// inference-net — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.inference.net/v1
export const inferenceNetProvider: RegistryEntry = {
  id: "inference-net",
  alias: "inference-net",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.inference.net/v1/chat/completions",
  modelsUrl: "https://api.inference.net/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
