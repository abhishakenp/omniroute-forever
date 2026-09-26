import type { RegistryEntry } from "../../shared.ts";

// uncloseai.com — free, no-auth OpenAI-compatible gateway hosted at unturf.com.
// Models served from hermes.ai.unturf.com (Qwen3.6-27B) and qwen.ai.unturf.com (closed).
// Any non-empty string works as the API key.
export const uncloseaiProvider: RegistryEntry = {
  id: "uncloseai",
  alias: "unc",
  format: "openai",
  executor: "default",
  baseUrl: "https://hermes.ai.unturf.com/v1/chat/completions",
  modelsUrl: "https://hermes.ai.unturf.com/v1/models",
  authType: "optional",
  authHeader: "bearer",
  passthroughModels: true,
  models: [
    { id: "Lorbus/Qwen3.6-27B-int4-AutoRound", name: "Qwen3.6 27B (UncloseAI)" },
  ],
};
