import type { RegistryEntry } from "../../shared.ts";

// agentrouter — OpenAI-compatible, free tier with signup credits.
// Base URL: https://agentrouter.org/v1
export const agentrouterProvider: RegistryEntry = {
  id: "agentrouter",
  alias: "agentrouter",
  format: "openai",
  executor: "default",
  baseUrl: "https://agentrouter.org/v1/chat/completions",
  modelsUrl: "https://agentrouter.org/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
