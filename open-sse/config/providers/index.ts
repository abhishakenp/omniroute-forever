import type { RegistryEntry } from "./shared.ts";

import { mistralProvider } from "./registry/mistral/index.ts";
import { cohereProvider } from "./registry/cohere/index.ts";
import { openrouterProvider } from "./registry/openrouter/index.ts";
import { deepseekProvider } from "./registry/deepseek/index.ts";
import { bazaarlinkProvider } from "./registry/bazaarlink/index.ts";
import { api_airforceProvider } from "./registry/api-airforce/index.ts";
import { duckduckgo_webProvider } from "./registry/duckduckgo-web/index.ts";
import { felo_webProvider } from "./registry/felo-web/index.ts";
import { opencodeProvider } from "./registry/opencode/index.ts";
import { opencode_zenProvider } from "./registry/opencode/zen/index.ts";
import { opencode_goProvider } from "./registry/opencode/go/index.ts";
import { auggieProvider } from "./registry/auggie/index.ts";
import { huggingchatProvider } from "./registry/huggingchat/index.ts";
import { puterProvider } from "./registry/puter/index.ts";
import { lmarenaProvider } from "./registry/lmarena/index.ts";
import { pollinationsProvider } from "./registry/pollinations/index.ts";
import { hackclubProvider } from "./registry/hackclub/index.ts";
import { freemodel_devProvider } from "./registry/freemodel-dev/index.ts";
import { chutesProvider } from "./registry/chutes/index.ts";
import { syntheticProvider } from "./registry/synthetic/index.ts";
import { freetheaiProvider } from "./registry/freetheai/index.ts";
import { aihordeProvider } from "./registry/aihorde/index.ts";
import { g4f_groqProvider } from "./registry/g4f-groq/index.ts";
import { g4f_geminiProvider } from "./registry/g4f-gemini/index.ts";
import { g4f_pollinationsProvider } from "./registry/g4f-pollinations/index.ts";
import { g4f_ollamaProvider } from "./registry/g4f-ollama/index.ts";
import { g4f_nvidiaProvider } from "./registry/g4f-nvidia/index.ts";
import { publicaiProvider } from "./registry/publicai/index.ts";
import { freeaiapikeyProvider } from "./registry/freeaiapikey/index.ts";
import { openadapterProvider } from "./registry/openadapter/index.ts";

export const REGISTRY: Record<string, RegistryEntry> = {
  mistral: mistralProvider,
  cohere: cohereProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  bazaarlink: bazaarlinkProvider,
  "api-airforce": api_airforceProvider,
  "duckduckgo-web": duckduckgo_webProvider,
  "felo-web": felo_webProvider,
  opencode: opencodeProvider,
  "opencode-zen": opencode_zenProvider,
  "opencode-go": opencode_goProvider,
  auggie: auggieProvider,
  huggingchat: huggingchatProvider,
  puter: puterProvider,
  lmarena: lmarenaProvider,
  pollinations: pollinationsProvider,
  hackclub: hackclubProvider,
  "freemodel-dev": freemodel_devProvider,
  chutes: chutesProvider,
  synthetic: syntheticProvider,
  freetheai: freetheaiProvider,
  aihorde: aihordeProvider,
  "g4f-groq": g4f_groqProvider,
  "g4f-gemini": g4f_geminiProvider,
  "g4f-pollinations": g4f_pollinationsProvider,
  "g4f-ollama": g4f_ollamaProvider,
  "g4f-nvidia": g4f_nvidiaProvider,
  publicai: publicaiProvider,
  freeaiapikey: freeaiapikeyProvider,
  openadapter: openadapterProvider,
};
