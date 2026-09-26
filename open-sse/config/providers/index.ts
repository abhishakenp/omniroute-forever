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
import { uncloseaiProvider } from "./registry/uncloseai/index.ts";
import { llm7Provider } from "./registry/llm7/index.ts";
import { dahlProvider } from "./registry/dahl/index.ts";
import { ainativeProvider } from "./registry/ainative/index.ts";

// Free-tier providers — auto-provisioned
import { bytezProvider } from "./registry/bytez/index.ts";
import { charmHyperProvider } from "./registry/charm-hyper/index.ts";
import { dgridProvider } from "./registry/dgrid/index.ts";
import { pioneerProvider } from "./registry/pioneer/index.ts";
import { requestyProvider } from "./registry/requesty/index.ts";
import { routewayProvider } from "./registry/routeway/index.ts";
import { sarvamProvider } from "./registry/sarvam/index.ts";
import { typhoonProvider } from "./registry/typhoon/index.ts";
import { internlmProvider } from "./registry/internlm/index.ts";
import { inceptionProvider } from "./registry/inception/index.ts";
import { friendliaiProvider } from "./registry/friendliai/index.ts";
import { ai21Provider } from "./registry/ai21/index.ts";
import { blackboxProvider } from "./registry/blackbox/index.ts";
import { sealionProvider } from "./registry/sealion/index.ts";
import { featherlessProvider } from "./registry/featherless/index.ts";
import { deepinfraProvider } from "./registry/deepinfra/index.ts";
import { fireworksProvider } from "./registry/fireworks/index.ts";
import { agentrouterProvider } from "./registry/agentrouter/index.ts";
import { basetenProvider } from "./registry/baseten/index.ts";
import { inferenceNetProvider } from "./registry/inference-net/index.ts";
import { nebiusProvider } from "./registry/nebius/index.ts";
import { nscaleProvider } from "./registry/nscale/index.ts";
import { navyProvider } from "./registry/navy/index.ts";
import { scalewayProvider } from "./registry/scaleway/index.ts";
import { morphProvider } from "./registry/morph/index.ts";
import { longcatProvider } from "./registry/longcat/index.ts";
import { modelscopeProvider } from "./registry/modelscope/index.ts";
import { groqProvider } from "./registry/groq/index.ts";
import { cerebrasProvider } from "./registry/cerebras/index.ts";
import { huggingfaceProvider } from "./registry/huggingface/index.ts";
import { sambanovaProvider } from "./registry/sambanova/index.ts";
import { novitaProvider } from "./registry/novita/index.ts";
import { nvidiaProvider } from "./registry/nvidia/index.ts";
import { siliconflowProvider } from "./registry/siliconflow/index.ts";
import { hyperbolicProvider } from "./registry/hyperbolic/index.ts";
import { geminiProvider } from "./registry/gemini/index.ts";

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
  uncloseai: uncloseaiProvider,
  llm7: llm7Provider,
  dahl: dahlProvider,
  ainative: ainativeProvider,
  // Free-tier providers — auto-provisioned
  bytez: bytezProvider,
  "charm-hyper": charmHyperProvider,
  dgrid: dgridProvider,
  pioneer: pioneerProvider,
  requesty: requestyProvider,
  routeway: routewayProvider,
  sarvam: sarvamProvider,
  typhoon: typhoonProvider,
  internlm: internlmProvider,
  inception: inceptionProvider,
  friendliai: friendliaiProvider,
  ai21: ai21Provider,
  blackbox: blackboxProvider,
  sealion: sealionProvider,
  featherless: featherlessProvider,
  deepinfra: deepinfraProvider,
  fireworks: fireworksProvider,
  agentrouter: agentrouterProvider,
  baseten: basetenProvider,
  "inference-net": inferenceNetProvider,
  nebius: nebiusProvider,
  nscale: nscaleProvider,
  navy: navyProvider,
  scaleway: scalewayProvider,
  morph: morphProvider,
  longcat: longcatProvider,
  modelscope: modelscopeProvider,
  groq: groqProvider,
  cerebras: cerebrasProvider,
  huggingface: huggingfaceProvider,
  sambanova: sambanovaProvider,
  novita: novitaProvider,
  nvidia: nvidiaProvider,
  siliconflow: siliconflowProvider,
  hyperbolic: hyperbolicProvider,
  gemini: geminiProvider,
};
