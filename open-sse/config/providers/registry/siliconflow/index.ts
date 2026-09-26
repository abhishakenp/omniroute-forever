import type { RegistryEntry } from "../../shared.ts";

// siliconflow — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.siliconflow.com/v1
export const siliconflowProvider: RegistryEntry = {
  id: "siliconflow",
  alias: "siliconflow",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.siliconflow.com/v1/chat/completions",
  modelsUrl: "https://api.siliconflow.com/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
