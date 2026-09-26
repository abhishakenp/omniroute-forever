import type { RegistryEntry } from "../../shared.ts";

// deepinfra — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.deepinfra.com/v1/openai
export const deepinfraProvider: RegistryEntry = {
  id: "deepinfra",
  alias: "deepinfra",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.deepinfra.com/v1/openai/chat/completions",
  modelsUrl: "https://api.deepinfra.com/v1/openai/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
