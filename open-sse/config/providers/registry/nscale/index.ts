import type { RegistryEntry } from "../../shared.ts";

// nscale — OpenAI-compatible, free tier with signup credits.
// Base URL: https://inference.api.nscale.com/v1
export const nscaleProvider: RegistryEntry = {
  id: "nscale",
  alias: "nscale",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference.api.nscale.com/v1/chat/completions",
  modelsUrl: "https://inference.api.nscale.com/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
