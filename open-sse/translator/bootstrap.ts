/**
 * Lazy translator bootstrap.
 *
 * Instead of eagerly importing all 18 adapter modules at module-evaluation time
 * (which pulls ~200MB of transitive deps into memory on first request), this
 * module registers only the *paths* to each adapter. The actual adapter module
 * is require()'d on first lookup in registry.ts (getRequestTranslator /
 * getResponseTranslator), so unused translators never load.
 *
 * Bun supports synchronous require() for ESM modules, so the lookup API stays
 * synchronous — no caller changes required.
 *
 * Each adapter module calls register() as a side effect when required, which
 * overwrites the lazy path placeholder with the concrete translator function.
 */
import { FORMATS } from "./formats.ts";
import { registerLazy } from "./registry.ts";

// Adapter module paths, relative to this file.
const REQ = (p: string) => `./request/${p}`;
const RES = (p: string) => `./response/${p}`;

type LazyEntry = {
  from: string;
  to: string;
  requestPath?: string;
  responsePath?: string;
};

// (from, to) -> adapter module(s). Built from the register() calls each
// adapter makes as a side effect. A single module may register multiple pairs;
// requiring it populates every pair it owns.
const LAZY_ENTRIES: LazyEntry[] = [
  { from: FORMATS.OPENAI, to: FORMATS.CLAUDE, requestPath: REQ("openai-to-claude.ts"), responsePath: RES("claude-to-openai.ts") },
  { from: FORMATS.GEMINI, to: FORMATS.OPENAI, requestPath: REQ("gemini-to-openai.ts"), responsePath: RES("gemini-to-openai.ts") },
  { from: FORMATS.OPENAI, to: FORMATS.GEMINI, requestPath: REQ("openai-to-gemini.ts"), responsePath: RES("openai-to-gemini.ts") },
  { from: FORMATS.OPENAI_RESPONSES, to: FORMATS.OPENAI, requestPath: REQ("openai-responses.ts"), responsePath: RES("openai-responses.ts") },
  { from: FORMATS.OPENAI, to: FORMATS.OPENAI_RESPONSES, requestPath: REQ("openai-responses.ts"), responsePath: RES("openai-responses.ts") },
];

export function bootstrapTranslatorRegistry() {
  for (const entry of LAZY_ENTRIES) {
    registerLazy(entry.from, entry.to, entry.requestPath, entry.responsePath);
  }
}
