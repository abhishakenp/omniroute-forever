import type { RegistryEntry } from "../../shared.ts";

// friendliai — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.friendli.ai/serverless/v1
export const friendliaiProvider: RegistryEntry = {
  id: "friendliai",
  alias: "friendliai",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.friendli.ai/serverless/v1/chat/completions",
  modelsUrl: "https://api.friendli.ai/serverless/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
