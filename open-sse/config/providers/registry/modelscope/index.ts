import type { RegistryEntry } from "../../shared.ts";

// modelscope — OpenAI-compatible, free tier with signup credits.
// Base URL: https://api-inference.modelscope.cn/v1
export const modelscopeProvider: RegistryEntry = {
  id: "modelscope",
  alias: "modelscope",
  format: "openai",
  executor: "default",
  baseUrl: "https://api-inference.modelscope.cn/v1/chat/completions",
  modelsUrl: "https://api-inference.modelscope.cn/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [],
};
