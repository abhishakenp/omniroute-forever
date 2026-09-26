import type { RegistryEntry } from "../../shared.ts";

// fireworks — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.fireworks.ai/inference/v1
export const fireworksProvider: RegistryEntry = {
  id: "fireworks",
  alias: "fireworks",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
  modelsUrl: "https://api.fireworks.ai/inference/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
