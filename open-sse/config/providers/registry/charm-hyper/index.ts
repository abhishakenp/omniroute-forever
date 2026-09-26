import type { RegistryEntry } from "../../shared.ts";

// charm-hyper — OpenAI-compatible, free tier with signup credits.
// Base URL: https://hyper.charm.land/v1
export const charmHyperProvider: RegistryEntry = {
  id: "charm-hyper",
  alias: "charm-hyper",
  format: "openai",
  executor: "default",
  baseUrl: "https://hyper.charm.land/v1/chat/completions",
  modelsUrl: "https://hyper.charm.land/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
