import type { RegistryEntry } from "../../shared.ts";

// Blackbox AI — OpenAI-compatible, free tier with unlimited basic chat.
// Base URL: https://api.blackbox.ai (no /v1 prefix)
export const blackboxProvider: RegistryEntry = {
  id: "blackbox",
  alias: "blackbox",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.blackbox.ai/chat/completions",
  modelsUrl: "https://api.blackbox.ai/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
