import type { RegistryEntry } from "../../shared.ts";

// featherless — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.featherless.ai/v1
export const featherlessProvider: RegistryEntry = {
  id: "featherless",
  alias: "featherless",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.featherless.ai/v1/chat/completions",
  modelsUrl: "https://api.featherless.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
