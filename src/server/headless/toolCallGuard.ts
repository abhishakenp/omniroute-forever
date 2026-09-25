/**
 * Catch an upstream that swallows tool calls, end the stream so the client
 * retries, and send that retry somewhere that will actually call the tool.
 *
 * ## What the failure looks like
 *
 * `dahl/MiniMaxAI/MiniMax-M2.7` — the model `auto/best-free` lands on most — runs
 * a tool-call parser upstream. When the parser cannot make sense of a call it
 * does not fail: it keeps the stream open and sends one `{"delta":{}}` per
 * swallowed token, then ends `finish_reason: "stop"` with no `tool_calls`.
 * The client waits the whole generation out and gets nothing it can run.
 *
 * Measured on 52 captured rlm responses through this gateway: every healthy
 * tool call (29 of them, MiniMax and codestral) had at most 9 empty deltas in
 * a row, and tool_calls chunks began within those 9. The dropped calls ran
 * 107, 125, 1,968 and 2,146 empty deltas — the last two cost the user 64s and
 * 150s each, twice in one turn. Replaying that user's request 24 times: 12
 * dropped, 12 called the tool, all on MiniMax. Small tool calls drop far less
 * (2 of 31 in the captures): the parser fails on large arguments.
 *
 * ## What this does
 *
 * 1. **Cut.** For streamed requests carrying `tools`, the upstream body passes
 *    through byte for byte while a small SSE reader counts consecutive empty
 *    deltas. At EMPTY_DELTA_LIMIT in a row the call is lost: the stream ends
 *    with an OpenAI-shaped `error` event (the OpenAI SDKs throw on it, and a
 *    client's retry treats it like any other upstream failure) and the
 *    upstream read is cancelled. Content already forwarded cannot be taken
 *    back, which is why this ends the stream rather than failing over inside it.
 *
 * 2. **Send the retry elsewhere — only to a model that does better.** The
 *    client's retry carries the same conversation, so the gateway knows which
 *    model dropped it. For each model the guard keeps tool-request outcomes —
 *    called the tool, answered in prose, or dropped the call — persisted in
 *    HEALTH_FILE. A retry moves off the model that dropped it only to a model
 *    whose measured tool success rate (MIN_ATTEMPTS or more requests) is at
 *    least as good; otherwise it stays, and the cut keeps each miss cheap.
 *
 * Why a rate, and why only retries (both measured, both learned the hard way):
 * - "Next in the pool" was codestral, which answered the dropping request in
 *   prose 17 times of 17: no error, so no retry, and no tool call.
 * - A first version demoted a model that dropped for ALL tool requests while
 *   any model had ever called a tool. On the live gateway that sent every tool
 *   request to codestral first for 40 minutes, because codestral had called
 *   tools on easy requests (95 times) — while MiniMax, which dropped 4 large
 *   calls, had made 185. A drop now costs seconds, so there is no global
 *   demotion; a model's rate already carries its drops.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Consecutive `{}` deltas that mean a swallowed call. Healthy max seen: 9. */
export const EMPTY_DELTA_LIMIT = 24;

/** Outcomes a model needs before its rate is trusted over staying put. */
const MIN_ATTEMPTS = 5;
/** How long a request remembers which models dropped it (covers client retries). */
const REQUEST_MEMORY_MS = 15 * 60_000;
const MAX_REQUEST_MEMORY = 500;

/** Tool-request outcomes per model: requests seen, tool calls made, calls dropped. */
interface Outcomes {
  attempts: number;
  toolCalls: number;
  drops: number;
}

const outcomes = new Map<string, Outcomes>();
const droppedFor = new Map<string, { models: Map<string, number>; at: number }>();

/** Where learned outcomes survive restarts. */
const HEALTH_FILE = join(process.env.DATA_DIR || join(homedir(), ".omniroute"), "tool-call-health.json");
const PERSIST_DEBOUNCE_MS = 30_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const outcomeFor = (modelStr: string): Outcomes => {
  let o = outcomes.get(modelStr);
  if (!o) outcomes.set(modelStr, (o = { attempts: 0, toolCalls: 0, drops: 0 }));
  return o;
};

function loadOutcomes(): void {
  try {
    const saved = JSON.parse(readFileSync(HEALTH_FILE, "utf8")) as { outcomes?: Record<string, Outcomes> };
    for (const [model, o] of Object.entries(saved.outcomes ?? {})) {
      if (o && typeof o.attempts === "number") outcomes.set(model, { attempts: o.attempts, toolCalls: o.toolCalls ?? 0, drops: o.drops ?? 0 });
    }
  } catch {
    // No file yet, an older format, or unreadable: start from nothing and relearn.
  }
}
loadOutcomes();

function schedulePersist(): void {
  if (persistTimer || process.env.OMNIROUTE_TOOL_HEALTH_PERSIST === "0") return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      mkdirSync(dirname(HEALTH_FILE), { recursive: true });
      writeFileSync(HEALTH_FILE, JSON.stringify({ outcomes: Object.fromEntries(outcomes) }, null, 2));
    } catch {
      // Learning is an optimisation, never a failure path.
    }
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** True when the request asks for tools — the only case the parser breaks. */
export function requestHasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * Identity of a request across client retries: the conversation and the tools,
 * not the transport options a retry may change.
 */
export function requestKey(body: Record<string, unknown>): string {
  return createHash("sha1")
    .update(JSON.stringify(body.messages ?? null))
    .update(JSON.stringify(body.tools ?? null))
    .digest("hex");
}

/** Record how a streamed tool request ended on `modelStr`. */
export function recordToolOutcome(modelStr: string, outcome: "tool" | "prose" | "drop", key?: string, now = Date.now()): void {
  const o = outcomeFor(modelStr);
  o.attempts++;
  if (outcome === "tool") o.toolCalls++;
  if (outcome === "drop") {
    o.drops++;
    if (key) {
      const entry = droppedFor.get(key);
      if (entry && now - entry.at < REQUEST_MEMORY_MS) {
        entry.models.set(modelStr, (entry.models.get(modelStr) ?? 0) + 1);
        entry.at = now;
      } else {
        droppedFor.set(key, { models: new Map([[modelStr, 1]]), at: now });
      }
      if (droppedFor.size > MAX_REQUEST_MEMORY) {
        for (const [k, v] of droppedFor) if (now - v.at >= REQUEST_MEMORY_MS) droppedFor.delete(k);
        while (droppedFor.size > MAX_REQUEST_MEMORY) droppedFor.delete(droppedFor.keys().next().value!);
      }
    }
  }
  schedulePersist();
}

/** Tool success rate, or null until MIN_ATTEMPTS outcomes are known. */
export function toolSuccessRate(modelStr: string): number | null {
  const o = outcomes.get(modelStr);
  return o && o.attempts >= MIN_ATTEMPTS ? o.toolCalls / o.attempts : null;
}

/** Models that already dropped this very request (its client is retrying), with counts. */
export function droppedForRequest(key: string, now = Date.now()): Map<string, number> {
  const entry = droppedFor.get(key);
  return entry && now - entry.at < REQUEST_MEMORY_MS ? entry.models : new Map();
}

/** True when this tool request is a retry of one that dropped — the only case re-planned. */
export function needsToolPlanning(key: string, now = Date.now()): boolean {
  return droppedForRequest(key, now).size > 0;
}

/**
 * Order candidates for a retry of a tool request that dropped. Pool order is
 * kept unless some other candidate's tool success rate is at least as good as
 * the rate of the model that dropped; then that candidate goes first and the
 * dropped model second — never behind models nobody has measured.
 */
export function planToolTargets<T extends { modelStr: string }>(targets: T[], key: string, now = Date.now()): T[] {
  const dropped = droppedForRequest(key, now);
  if (dropped.size === 0) return targets;
  const droppedRate = Math.max(0, ...[...dropped.keys()].map((m) => toolSuccessRate(m) ?? 0));
  let best: T | undefined;
  let bestRate = -1;
  for (const t of targets) {
    if (dropped.has(t.modelStr)) continue;
    const rate = toolSuccessRate(t.modelStr);
    if (rate !== null && rate >= droppedRate && rate > bestRate) {
      best = t;
      bestRate = rate;
    }
  }
  if (!best) return targets;
  const chosen = best;
  const moved = targets.filter((t) => t.modelStr === chosen.modelStr);
  const droppedTargets = targets.filter((t) => dropped.has(t.modelStr));
  const rest = targets.filter((t) => t.modelStr !== chosen.modelStr && !dropped.has(t.modelStr));
  return [...moved, ...droppedTargets, ...rest];
}

/** For logs and tests. */
export function toolOutcomeStats(): Record<string, Outcomes & { rate: number | null }> {
  const out: Record<string, Outcomes & { rate: number | null }> = {};
  for (const [model, o] of outcomes) out[model] = { ...o, rate: toolSuccessRate(model) };
  return out;
}

/** Test seam. */
export function resetToolCallDrops(): void {
  outcomes.clear();
  droppedFor.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
}

/**
 * Pass `body` through unchanged while watching for a swallowed tool call.
 * `onDrop` runs once, when the stream is cut; `onToolCall` once, at the first
 * `tool_calls` chunk.
 */
export function guardToolCallStream(
  body: ReadableStream<Uint8Array>,
  opts: {
    modelStr: string;
    onDrop: (emptyRun: number) => void;
    onToolCall?: () => void;
    /** A stream that ended normally without any tool call. */
    onProse?: () => void;
    limit?: number;
  }
): ReadableStream<Uint8Array> {
  const limit = opts.limit ?? EMPTY_DELTA_LIMIT;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = body.getReader();
  let pending = "";
  let emptyRun = 0;
  let sawToolCall = false;
  let cut = false;

  /** Feed decoded text; returns true once the limit is reached. */
  const scan = (text: string): boolean => {
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (!choice.finish_reason && choice.delta && Object.keys(choice.delta).length === 0) {
        if (++emptyRun >= limit) return true;
      } else {
        emptyRun = 0;
        if (!sawToolCall && choice.delta?.tool_calls) {
          sawToolCall = true;
          opts.onToolCall?.();
        }
      }
    }
    return false;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cut) return;
      const { done, value } = await reader.read();
      if (done) {
        if (!sawToolCall) opts.onProse?.();
        controller.close();
        return;
      }
      // Forward first: the bytes that led up to the cut are already valid SSE.
      controller.enqueue(value);
      if (scan(decoder.decode(value, { stream: true }))) {
        cut = true;
        opts.onDrop(emptyRun);
        const error = {
          error: {
            message: `Upstream ${opts.modelStr} dropped a tool call; retry routes elsewhere`,
            type: "upstream_error",
            code: "tool_call_dropped",
            param: null,
          },
        };
        controller.enqueue(encoder.encode(`\n\ndata: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`));
        controller.close();
        void reader.cancel().catch(() => {});
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}
