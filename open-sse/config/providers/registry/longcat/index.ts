import type { RegistryEntry } from "../../shared.ts";

// longcat — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.longcat.chat/openai/v1
export const longcatProvider: RegistryEntry = {
  id: "longcat",
  alias: "longcat",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.longcat.chat/openai/v1/chat/completions",
  modelsUrl: "https://api.longcat.chat/openai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
