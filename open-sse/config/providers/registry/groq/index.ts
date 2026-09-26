import type { RegistryEntry } from "../../shared.ts";

// groq — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.groq.com/openai/v1
export const groqProvider: RegistryEntry = {
  id: "groq",
  alias: "groq",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.groq.com/openai/v1/chat/completions",
  modelsUrl: "https://api.groq.com/openai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
