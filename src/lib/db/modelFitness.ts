/**
 * Which models can actually serve THIS request.
 *
 * The thin gateway used to hand the iterator a request and get back whatever
 * models a provider happened to list first. Two whole classes of upstream call
 * were guaranteed to fail before they were made:
 *
 *   1. Models that cannot do chat at all. `cohere-transcribe-03-2026` sits at
 *      index 2 of cohere's alphabetically-sorted catalog, so it landed inside
 *      the `slice(0, 5)` candidate window on every single best-free request.
 *      Measured in ~/.omniroute/logs/omniroute.log: 8,322 attempts, 8,322
 *      failures, all `400 invalid request: model '...' is not supported`.
 *
 *   2. Models whose context window is smaller than the prompt. Measured in the
 *      same log: 24,638 `TOO_MANY_TOKENS` 400s, of which 24,626 come from three
 *      cohere models that were tried ahead of `command-a-plus-05-2026` — the
 *      one free model that could hold the prompt, and the LAST one tried.
 *
 * Together that is 32,948 of 161,343 attempts (20.4%) that could not have
 * succeeded. They are not free: each one burns a provider's rate-limit budget,
 * which is what turns a busy moment into `503 All providers exhausted`.
 *
 * This module is pure — no DB, no network, no clock — so it can be checked
 * against the real catalog without standing anything up.
 */

/** Chars per token. Deliberately conservative: under-estimating tokens is what
 *  lets an over-large prompt through to a model that will refuse it. */
const CHARS_PER_TOKEN = 3.5;

/** Leave headroom for the reply plus the provider's own prompt scaffolding. */
const CONTEXT_SAFETY_MARGIN_TOKENS = 512;

/**
 * Model-id substrings that mean "this endpoint is not chat completions".
 *
 * Conservative by design: only families that categorically cannot answer a chat
 * request. Anything merely unusual (translate, reasoning, vision, guard) stays
 * a candidate — a vision or translate model still speaks the chat protocol, and
 * the context check below is what should exclude it when the prompt is too big.
 */
const NON_CHAT_MARKERS = [
  "embed",
  "rerank",
  "transcribe",
  "whisper",
  "text-to-speech",
  "tts",
  "-stt",
  "dall-e",
  "stable-diffusion",
  "sdxl",
  "flux",
  "imagen",
  "-ocr",
  "moderation",
] as const;

/** A model record as it appears either in synced catalogs or the registry. */
export interface ModelLike {
  id?: string;
  /** Synced provider catalogs (`key_value` namespace `syncedAvailableModels`). */
  inputTokenLimit?: number | null;
  /** Static registry entries (`open-sse/config/providers/**`). */
  contextLength?: number | null;
}

/** True when the id does not name a categorically non-chat endpoint. */
export function isChatCapableModelId(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  return !NON_CHAT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The model's usable input window, or undefined when nothing declares one.
 *
 * Synced catalogs carry `inputTokenLimit`; the static registry carries
 * `contextLength`; a provider may declare a blanket `defaultContextLength`.
 * Unknown stays unknown — see `modelFits`, which treats unknown as eligible
 * rather than inventing a number.
 */
export function modelContextLimit(
  model: ModelLike,
  providerDefault?: number | null
): number | undefined {
  const candidates = [model.inputTokenLimit, model.contextLength, providerDefault];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** Rough token count for a chat-completions body. */
export function estimatePromptTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (content != null) {
      // Multipart content (text + image parts) — measure the serialized form
      // rather than skipping it, so an image-heavy prompt is not counted as 0.
      chars += JSON.stringify(content).length;
    }
    chars += 8; // role + framing overhead per message
  }
  // Tool definitions are part of the prompt the provider must hold.
  const tools = (body as { tools?: unknown }).tools;
  if (Array.isArray(tools) && tools.length > 0) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Tokens the reply is allowed to occupy, which the window must also hold. */
export function requestedOutputTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const record = body as Record<string, unknown>;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * Can a window of `limit` hold this request?
 *
 * An unknown limit returns true. Refusing to try a model just because its
 * catalog entry is silent would delete most of the keyless pool, which declares
 * nothing — that trades a measurable waste for an unmeasured outage.
 */
export function modelFits(
  limit: number | undefined,
  promptTokens: number,
  outputTokens = 0
): boolean {
  if (limit === undefined) return true;
  return limit >= promptTokens + outputTokens + CONTEXT_SAFETY_MARGIN_TOKENS;
}

export interface FitOptions {
  promptTokens: number;
  outputTokens?: number;
  providerDefaultContext?: number | null;
  /** Learned ceilings: "provider/model" → the smallest prompt it has refused. */
  refusedAbove?: Map<string, number>;
  provider?: string;
  /** How many candidates to keep. */
  cap?: number;
}

/**
 * Order and trim a provider's models for one specific request.
 *
 * Ordering is the half that matters most. Even with nothing excluded, trying
 * the widest window first turns the measured cohere sequence — three
 * `TOO_MANY_TOKENS` refusals and one unsupported-endpoint refusal before the
 * model that works — into a single call that succeeds.
 */
export function selectFittingModels(models: ModelLike[], options: FitOptions): string[] {
  const {
    promptTokens,
    outputTokens = 0,
    providerDefaultContext,
    refusedAbove,
    provider,
    cap = 5,
  } = options;

  const scored: Array<{ id: string; limit: number }> = [];
  for (const model of models) {
    const id = typeof model?.id === "string" ? model.id : "";
    if (!id) continue;
    if (!isChatCapableModelId(id)) continue;

    const limit = modelContextLimit(model, providerDefaultContext);
    if (!modelFits(limit, promptTokens, outputTokens)) continue;

    // A model that has already refused a prompt this size is not a candidate,
    // however wide its catalog entry claims to be. Cohere Trial keys advertise
    // 128k on c4ai-aya-expanse-32b and refuse at ~16k; the catalog cannot be
    // taken at its word, so what the provider actually did is what counts.
    if (refusedAbove && provider) {
      const ceiling = refusedAbove.get(`${provider}/${id}`);
      if (ceiling !== undefined && promptTokens >= ceiling) continue;
    }

    // Unknown windows sort last: try what is known to fit before gambling.
    scored.push({ id, limit: limit ?? -1 });
  }

  scored.sort((a, b) => b.limit - a.limit);
  return scored.slice(0, cap).map((entry) => entry.id);
}
