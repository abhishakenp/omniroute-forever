import type { RegistryEntry } from "../../shared.ts";

// huggingface — OpenAI-compatible, free tier with signup credits.
// Base URL: https://router.huggingface.co/v1
export const huggingfaceProvider: RegistryEntry = {
  id: "huggingface",
  alias: "huggingface",
  format: "openai",
  executor: "default",
  baseUrl: "https://router.huggingface.co/v1/chat/completions",
  modelsUrl: "https://router.huggingface.co/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
