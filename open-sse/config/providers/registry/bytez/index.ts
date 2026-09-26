import type { RegistryEntry } from "../../shared.ts";

// bytez — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.bytez.com/models/v2/openai/v1
export const bytezProvider: RegistryEntry = {
  id: "bytez",
  alias: "bytez",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.bytez.com/models/v2/openai/v1/chat/completions",
  modelsUrl: "https://api.bytez.com/models/v2/openai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
