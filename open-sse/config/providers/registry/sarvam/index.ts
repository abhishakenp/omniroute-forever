import type { RegistryEntry } from "../../shared.ts";

// sarvam — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.sarvam.ai/v1
export const sarvamProvider: RegistryEntry = {
  id: "sarvam",
  alias: "sarvam",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.sarvam.ai/v1/chat/completions",
  modelsUrl: "https://api.sarvam.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
