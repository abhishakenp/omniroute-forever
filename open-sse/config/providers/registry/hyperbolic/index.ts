import type { RegistryEntry } from "../../shared.ts";

// hyperbolic — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.hyperbolic.xyz/v1
export const hyperbolicProvider: RegistryEntry = {
  id: "hyperbolic",
  alias: "hyperbolic",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.hyperbolic.xyz/v1/chat/completions",
  modelsUrl: "https://api.hyperbolic.xyz/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
