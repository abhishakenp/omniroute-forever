import type { RegistryEntry } from "../../shared.ts";

// typhoon — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api.opentyphoon.ai/v1
export const typhoonProvider: RegistryEntry = {
  id: "typhoon",
  alias: "typhoon",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.opentyphoon.ai/v1/chat/completions",
  modelsUrl: "https://api.opentyphoon.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
