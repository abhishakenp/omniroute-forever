/**
 * System Prompt Injection — STUBBED (thin gateway).
 * Config storage kept for server-init compatibility; injection is a no-op.
 */

interface SystemPromptConfig {
  enabled: boolean;
  prefixPrompt: string;
  suffixPrompt: string;
  prompt: string;
}

const GLOBAL_KEY = "__omniroute_systemPrompt_config__";
const _store = globalThis as unknown as Record<string, SystemPromptConfig | undefined>;

function getConfig(): SystemPromptConfig {
  if (!_store[GLOBAL_KEY]) {
    _store[GLOBAL_KEY] = {
      enabled: false,
      prefixPrompt: "",
      suffixPrompt: "",
      prompt: "",
    };
  }
  return _store[GLOBAL_KEY]!;
}

export function setSystemPromptConfig(config: Partial<SystemPromptConfig>) {
  const current = getConfig();
  _store[GLOBAL_KEY] = { ...current, ...config };
}

export function getSystemPromptConfig() {
  return getConfig();
}

// No-op passthrough — thin gateway does not inject system prompts.
export function injectSystemPrompt<T>(body: T): T {
  return body;
}

export function injectCustomSystemPrompt<T>(
  body: Record<string, unknown>,
  _prompt: string
): T {
  return body as unknown as T;
}
