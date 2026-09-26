import type { RegistryEntry } from "../../shared.ts";

// gemini — OpenAI-compatible, free tier with signup credits.
// Base URL: https://generativelanguage.googleapis.com/v1beta/openai
export const geminiProvider: RegistryEntry = {
  id: "gemini",
  alias: "gemini",
  format: "openai",
  executor: "default",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
