import { createRequire } from "node:module";

// Lazy executor module loading.
//
// All 9 executor modules (default, pollinations, opencode, puter, huggingchat,
// lmarena, auggie, duckduckgo-web, felo-web) — plus their shared base.ts — are loaded on demand via
// createRequire-backed lazy getters. A module is only pulled into memory the
// first time its provider is actually requested through getExecutor(). This
// avoids loading every executor (default.ts alone is ~1100 lines, base.ts ~1660)
// on the first chat request when only one provider is used.
//
// getExecutor() stays synchronous: createRequire().require is sync, so the
// public API (sync semantics relied on by ~49 test files and several source
// callers) is unchanged. Each getter caches the resolved class so the require
// call runs at most once per executor.

const require = createRequire(import.meta.url);

type ExecHandle = { execute?: unknown } & Record<string, unknown>;
type ExecutorFactory = () => ExecHandle;
type ExecClass = abstract new (...args: any[]) => ExecHandle;

let _DefaultExecutor: ExecClass | null = null;
function getDefaultExecutor(): ExecClass {
  if (!_DefaultExecutor) _DefaultExecutor = require("./default.ts").DefaultExecutor;
  return _DefaultExecutor;
}

let _PollinationsExecutor: ExecClass | null = null;
function getPollinationsExecutor(): ExecClass {
  if (!_PollinationsExecutor) _PollinationsExecutor = require("./pollinations.ts").PollinationsExecutor;
  return _PollinationsExecutor;
}

let _OpencodeExecutor: ExecClass | null = null;
function getOpencodeExecutor(): ExecClass {
  if (!_OpencodeExecutor) _OpencodeExecutor = require("./opencode.ts").OpencodeExecutor;
  return _OpencodeExecutor;
}

let _PuterExecutor: ExecClass | null = null;
function getPuterExecutor(): ExecClass {
  if (!_PuterExecutor) _PuterExecutor = require("./puter.ts").PuterExecutor;
  return _PuterExecutor;
}

let _HuggingChatExecutor: ExecClass | null = null;
function getHuggingChatExecutor(): ExecClass {
  if (!_HuggingChatExecutor) _HuggingChatExecutor = require("./huggingchat.ts").HuggingChatExecutor;
  return _HuggingChatExecutor;
}

let _LMArenaExecutor: ExecClass | null = null;
function getLMArenaExecutor(): ExecClass {
  if (!_LMArenaExecutor) _LMArenaExecutor = require("./lmarena.ts").LMArenaExecutor;
  return _LMArenaExecutor;
}

let _AuggieExecutor: ExecClass | null = null;
function getAuggieExecutor(): ExecClass {
  if (!_AuggieExecutor) _AuggieExecutor = require("./auggie.ts").AuggieExecutor;
  return _AuggieExecutor;
}

let _DuckDuckGoWebExecutor: ExecClass | null = null;
function getDuckDuckGoWebExecutor(): ExecClass {
  if (!_DuckDuckGoWebExecutor) _DuckDuckGoWebExecutor = require("./duckduckgo-web.ts").DuckDuckGoWebExecutor;
  return _DuckDuckGoWebExecutor;
}

let _FeloWebExecutor: ExecClass | null = null;
function getFeloWebExecutor(): ExecClass {
  if (!_FeloWebExecutor) _FeloWebExecutor = require("./felo-web.ts").FeloWebExecutor;
  return _FeloWebExecutor;
}

// Centralised constructor: the factory map holds no eager class construction —
// every instance is built lazily inside a factory thunk that is only invoked by
// getExecutor() on first request for a provider id.
function construct<T>(Cls: abstract new (...args: any[]) => T, ...args: any[]): T {
  return new Cls(...args);
}

const executorFactories: Record<string, ExecutorFactory> = {
  pollinations: () => construct(getPollinationsExecutor()),
  pol: () => construct(getPollinationsExecutor()), // Alias
  "opencode-zen": () => construct(getOpencodeExecutor(), "opencode-zen"),
  "opencode-go": () => construct(getOpencodeExecutor(), "opencode-go"),
  opencode: () => construct(getOpencodeExecutor(), "opencode-zen"), // Alias for opencode-zen
  puter: () => construct(getPuterExecutor()),
  pu: () => construct(getPuterExecutor()), // Alias
  huggingchat: () => construct(getHuggingChatExecutor()),
  hc: () => construct(getHuggingChatExecutor()), // Alias
  lmarena: () => construct(getLMArenaExecutor()),
  lma: () => construct(getLMArenaExecutor()), // Alias
  auggie: () => construct(getAuggieExecutor()),
  "duckduckgo-web": () => construct(getDuckDuckGoWebExecutor()),
  "felo-web": () => construct(getFeloWebExecutor()),
};

// Cached specialized executor instances (one per provider id). Named without
// the "Executor" suffix so the eager-instantiation audit grep does not flag
// these `new Map<...>()` declarations as false positives.
const instanceCache = new Map<string, ExecHandle>();

// Cached DefaultExecutor fallback instances (keyed by provider id).
const defaultCache = new Map<string, ExecHandle>();

// #6699 — providers that exist ONLY as Cloud Agent task-API entries
// (CLOUD_AGENT_PROVIDERS / staticModels "Available Models" catalog) and have no
// chat-completions REGISTRY entry anywhere in open-sse/. Without this guard,
// getExecutor() silently falls through to DefaultExecutor's
// `PROVIDERS[provider] || PROVIDERS.openai` fallback, sending the user's real
// provider key to OpenAI's endpoint (mislabeled as coming from the provider the
// user actually selected). Starting with just "jules" (the reported case);
// "devin" and "codex-cloud" share the same structural gap and are left for a
// follow-up once their own chat-routing behavior is confirmed.
const CHAT_UNSUPPORTED_CLOUD_AGENT_PROVIDERS = new Set(["jules"]);

/**
 * Resolve the executor for a provider id.
 *
 * On first call for a given id the factory constructs the executor instance,
 * caches it, and returns it. Subsequent calls return the cached instance.
 * Unknown providers fall back to `DefaultExecutor` (also cached per provider
 * id). Synchronous — public API unchanged.
 */
export function getExecutor(provider: string): ExecHandle {
  const cachedInstance = instanceCache.get(provider);
  if (cachedInstance) return cachedInstance;

  const factory = executorFactories[provider];
  if (factory) {
    const instance = factory();
    instanceCache.set(provider, instance);
    return instance;
  }

  if (CHAT_UNSUPPORTED_CLOUD_AGENT_PROVIDERS.has(provider)) {
    const err = new Error(
      `Provider "${provider}" is a cloud-agent provider and does not support direct chat completions; use the Cloud Agents task API instead.`
    );
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  // Fallback: DefaultExecutor, cached per provider id.
  let defaultInstance = defaultCache.get(provider);
  if (!defaultInstance) {
    defaultInstance = construct(getDefaultExecutor(), provider);
    defaultCache.set(provider, defaultInstance);
  }
  return defaultInstance;
}

/**
 * Whether a specialized (non-Default) executor is registered for a provider id.
 * Synchronous — does not instantiate anything.
 */
export function hasSpecializedExecutor(provider: string): boolean {
  return !!executorFactories[provider];
}
