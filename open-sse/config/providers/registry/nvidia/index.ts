import type { RegistryEntry } from "../../shared.ts";

// nvidia — OpenAI-compatible, free tier with signup credits.
// Base URL: https://integrate.api.nvidia.com/v1
export const nvidiaProvider: RegistryEntry = {
  id: "nvidia",
  alias: "nvidia",
  format: "openai",
  executor: "default",
  baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
  modelsUrl: "https://integrate.api.nvidia.com/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
