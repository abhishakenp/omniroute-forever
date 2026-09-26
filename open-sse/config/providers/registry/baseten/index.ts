import type { RegistryEntry } from "../../shared.ts";

// baseten — OpenAI-compatible, free tier with signup credits.
// Base URL: https://inference.baseten.co/v1
export const basetenProvider: RegistryEntry = {
  id: "baseten",
  alias: "baseten",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference.baseten.co/v1/chat/completions",
  modelsUrl: "https://inference.baseten.co/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
