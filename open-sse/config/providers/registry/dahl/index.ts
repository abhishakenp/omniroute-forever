import type { RegistryEntry } from "../../shared.ts";

// Dahl Inference — OpenAI-compatible, browserless signup, 100M free tokens.
// Provisioned via POST /v1/auth/signup (no email/browser needed).
// Base URL: https://inference.dahl.global
export const dahlProvider: RegistryEntry = {
  id: "dahl",
  alias: "dahl",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference.dahl.global/v1/chat/completions",
  modelsUrl: "https://inference.dahl.global/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: [
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7 (Dahl)" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6 (Dahl)" },
  ],
};
