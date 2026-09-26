import type { RegistryEntry } from "../../shared.ts";

// llm7.io — free, no-signup OpenAI-compatible gateway.
// API at api.llm7.io. Free tier (turbo): 2 req/s, 20 RPM, 100 req/hr.
// Use "unused" as API key for free tier. Get token at token.llm7.io for higher limits.
export const llm7Provider: RegistryEntry = {
  id: "llm7",
  alias: "llm7",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.llm7.io/v1/chat/completions",
  modelsUrl: "https://api.llm7.io/v1/models",
  authType: "optional",
  authHeader: "bearer",
  passthroughModels: true,
  models: [
    { id: "codestral-latest", name: "Codestral (LLM7)" },
    { id: "gemma4:31b", name: "Gemma 4 31B (LLM7)" },
    { id: "gpt-oss", name: "GPT-OSS (LLM7)" },
    { id: "meta-Llama-3.1-8B-Instruct-Turbo", name: "Llama 3.1 8B Turbo (LLM7)" },
    { id: "minimax-m2.7", name: "MiniMax M2.7 (LLM7)" },
    { id: "mistral-Nemo-Instruct-2407", name: "Mistral Nemo (LLM7)" },
  ],
};
