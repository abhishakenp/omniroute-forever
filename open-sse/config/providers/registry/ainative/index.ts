import type { RegistryEntry } from "../../shared.ts";

// AINative Studio — OpenAI-compatible, zero-auth provisioning, open-source models only.
// Provisioned via POST /api/v1/public/instant-db (no email/browser needed).
// Auth: X-API-Key header (NOT Bearer). Keys are temporary (~72h).
// Base URL: https://api.ainative.studio
export const ainativeProvider: RegistryEntry = {
  id: "ainative",
  alias: "ainative",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.ainative.studio/v1/chat/completions",
  modelsUrl: "https://api.ainative.studio/v1/models",
  authType: "apikey",
  authHeader: "x-api-key",
  passthroughModels: true,
  models: [
    { id: "deepseek-v3", name: "DeepSeek V3 (AINative)" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (AINative)" },
    { id: "glm-5", name: "GLM 5 (AINative)" },
    { id: "gemma-4-31b", name: "Gemma 4 31B (AINative)" },
    { id: "deepseek-r1", name: "DeepSeek R1 (AINative)" },
  ],
};
