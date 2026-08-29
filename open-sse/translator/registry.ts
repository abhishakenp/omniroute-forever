import { createRequire } from "module";

type RequestTranslator = (
  model: string,
  body: Record<string, unknown>,
  stream?: boolean,
  credentials?: Record<string, unknown> | null
) => unknown;

type ResponseTranslator = (
  chunk: Record<string, unknown>,
  state: Record<string, unknown>
) => unknown;

// A registry entry is either a concrete translator function (resolved) or a
// module path string that, when required, registers the concrete function(s)
// as a side effect. Lazy entries are resolved on first lookup via require().
type RequestEntry = RequestTranslator | string;
type ResponseEntry = ResponseTranslator | string;

const requestRegistry = new Map<string, RequestEntry>();
const responseRegistry = new Map<string, ResponseEntry>();

// Bun supports require() for ESM modules synchronously. createRequire gives us
// a require that resolves relative to this file regardless of the loader.
const require_ = createRequire(import.meta.url);

function makeKey(from: string, to: string) {
  return `${from}:${to}`;
}

export function register(
  from: string,
  to: string,
  requestFn?: RequestTranslator,
  responseFn?: ResponseTranslator
) {
  const key = makeKey(from, to);
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}

/**
 * Register a lazy module path for a (from, to) pair. The module is NOT loaded
 * until the translator is actually requested via getRequestTranslator /
 * getResponseTranslator. Requiring the module triggers its side-effect
 * register() call(s), which overwrite this lazy placeholder with the concrete
 * function.
 */
export function registerLazy(
  from: string,
  to: string,
  requestPath?: string,
  responsePath?: string
) {
  const key = makeKey(from, to);
  // Only set a lazy path placeholder if no concrete function is registered yet.
  // (A concrete function always wins over a lazy placeholder.)
  if (requestPath && !requestRegistry.has(key)) {
    requestRegistry.set(key, requestPath);
  }
  if (responsePath && !responseRegistry.has(key)) {
    responseRegistry.set(key, responsePath);
  }
}

// Auto-bootstrap on first translator lookup so callers never need to call
// bootstrapTranslatorRegistry() explicitly. Required lazily to avoid an eager
// import of bootstrap.ts (and its transitive graph) at module-eval time.
let bootstrapped = false;
function ensureBootstrapped() {
  if (bootstrapped) return;
  bootstrapped = true;
  try {
    const bootstrap = require_("./bootstrap.ts") as {
      bootstrapTranslatorRegistry: () => void;
    };
    bootstrap.bootstrapTranslatorRegistry();
  } catch {
    // If bootstrap fails, leave the lazy path entries absent; individual
    // lookups will simply return undefined, matching pre-bootstrap behavior.
  }
}

function resolveRequestEntry(key: string): RequestTranslator | undefined {
  ensureBootstrapped();
  const entry = requestRegistry.get(key);
  if (entry === undefined) return undefined;
  if (typeof entry === "string") {
    // Lazy: require the module (side-effect registers the concrete function),
    // then re-lookup. Guard against a module that fails to register the key by
    // falling back to undefined rather than re-returning the path string.
    require_(entry);
    const resolved = requestRegistry.get(key);
    return typeof resolved === "function" ? resolved : undefined;
  }
  return entry;
}

function resolveResponseEntry(key: string): ResponseTranslator | undefined {
  ensureBootstrapped();
  const entry = responseRegistry.get(key);
  if (entry === undefined) return undefined;
  if (typeof entry === "string") {
    require_(entry);
    const resolved = responseRegistry.get(key);
    return typeof resolved === "function" ? resolved : undefined;
  }
  return entry;
}

export function getRequestTranslator(from: string, to: string) {
  return resolveRequestEntry(makeKey(from, to));
}

export function getResponseTranslator(from: string, to: string) {
  return resolveResponseEntry(makeKey(from, to));
}
