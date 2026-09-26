import type { RegistryEntry } from "../../shared.ts";

// internlm — OpenAI-compatible, free tier with signup credits.
// Base URL: https://chat.intern-ai.org.cn/api/v1
export const internlmProvider: RegistryEntry = {
  id: "internlm",
  alias: "internlm",
  format: "openai",
  executor: "default",
  baseUrl: "https://chat.intern-ai.org.cn/api/v1/chat/completions",
  modelsUrl: "https://chat.intern-ai.org.cn/api/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
