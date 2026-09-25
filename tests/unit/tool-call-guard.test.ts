import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_DELTA_LIMIT,
  guardToolCallStream,
  needsToolPlanning,
  planToolTargets,
  recordToolOutcome,
  requestHasTools,
  requestKey,
  resetToolCallDrops,
  toolSuccessRate,
} from "../../src/server/headless/toolCallGuard.ts";

// Never write learned health to the real data dir from a test.
process.env.OMNIROUTE_TOOL_HEALTH_PERSIST = "0";

// Real responses captured from rlm's traffic through this gateway.
const FIXTURES = join(import.meta.dirname, "fixtures", "tool-call-guard");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

/** Split into uneven chunks so SSE lines straddle reads, as they do on the wire. */
const streamOf = (bytes: Uint8Array, size = 97) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });

const readAll = async (stream: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(stream).arrayBuffer());

test("a swallowed tool call ends the stream with an error event and reports the drop", async () => {
  const drops: number[] = [];
  const out = await readAll(
    guardToolCallStream(streamOf(fixture("minimax-dropped-125.sse")), {
      modelStr: "dahl/MiniMaxAI/MiniMax-M2.7",
      onDrop: (run) => drops.push(run),
    })
  );
  const text = out.toString("utf8");
  assert.deepEqual(drops, [EMPTY_DELTA_LIMIT]);
  assert.match(text, /"code":"tool_call_dropped"/);
  assert.match(text, /data: \[DONE\]\n\n$/);
  // Cut early: far fewer bytes than the upstream would have sent.
  assert.ok(out.length < fixture("minimax-dropped-125.sse").length);
});

test("a healthy tool call passes through byte for byte and is counted as a tool call", async () => {
  const bytes = fixture("minimax-tool-call.sse");
  let dropped = false;
  let toolCalls = 0;
  const out = await readAll(
    guardToolCallStream(streamOf(bytes), {
      modelStr: "m",
      onDrop: () => (dropped = true),
      onToolCall: () => toolCalls++,
    })
  );
  assert.equal(dropped, false);
  assert.equal(toolCalls, 1);
  assert.ok(out.equals(bytes));
});

test("a plain text answer passes through byte for byte and is counted as prose", async () => {
  const bytes = fixture("minimax-text.sse");
  let dropped = false;
  let prose = 0;
  const out = await readAll(
    guardToolCallStream(streamOf(bytes, 13), {
      modelStr: "m",
      onDrop: () => (dropped = true),
      onProse: () => prose++,
    })
  );
  assert.equal(dropped, false);
  assert.equal(prose, 1);
  assert.ok(out.equals(bytes));
});

test("only requests with tools are guarded", () => {
  assert.equal(requestHasTools({ tools: [{ type: "function" }] }), true);
  assert.equal(requestHasTools({ tools: [] }), false);
  assert.equal(requestHasTools({}), false);
});

const pool = ["dahl/MiniMax", "dahl/Kimi", "mistral/codestral", "cohere/command-a"].map((modelStr) => ({ modelStr }));
const order = (targets: { modelStr: string }[]) => targets.map((t) => t.modelStr);
const convo = { messages: [{ role: "user", content: "spawn subagents" }], tools: [{ type: "function" }] };
const outcomesFor = (model: string, tool: number, prose: number, drop: number) => {
  for (let i = 0; i < tool; i++) recordToolOutcome(model, "tool");
  for (let i = 0; i < prose; i++) recordToolOutcome(model, "prose");
  for (let i = 0; i < drop; i++) recordToolOutcome(model, "drop");
};

test("a first attempt is never re-planned, whatever the history", () => {
  resetToolCallDrops();
  outcomesFor("dahl/MiniMax", 5, 0, 5);
  outcomesFor("cohere/command-a", 10, 0, 0);
  const key = requestKey(convo);
  assert.equal(needsToolPlanning(key), false);
  assert.deepEqual(order(planToolTargets(pool, key)), order(pool));
  resetToolCallDrops();
});

test("a retry moves to the candidate with a better measured tool rate, then back to the dropped model", () => {
  resetToolCallDrops();
  outcomesFor("dahl/MiniMax", 8, 0, 2); // 80%
  outcomesFor("cohere/command-a", 9, 1, 0); // 90%
  outcomesFor("mistral/codestral", 5, 5, 0); // 50%
  const key = requestKey(convo);
  recordToolOutcome("dahl/MiniMax", "drop", key); // 8/11 ≈ 73%
  assert.equal(needsToolPlanning(key), true);
  assert.deepEqual(order(planToolTargets(pool, key)), [
    "cohere/command-a",
    "dahl/MiniMax",
    "dahl/Kimi",
    "mistral/codestral",
  ]);
  resetToolCallDrops();
});

test("the live regression: a model that only calls tools on easy requests does not take the retry", () => {
  resetToolCallDrops();
  // Shape of the live counts: MiniMax 185 tool calls with a few drops,
  // codestral 95 tool calls but also many prose answers to tool requests.
  outcomesFor("dahl/MiniMax", 185, 10, 4);
  outcomesFor("mistral/codestral", 95, 120, 0);
  const key = requestKey(convo);
  recordToolOutcome("dahl/MiniMax", "drop", key);
  assert.deepEqual(order(planToolTargets(pool, key)), order(pool));
  resetToolCallDrops();
});

test("unmeasured models (under the minimum) never take a retry", () => {
  resetToolCallDrops();
  outcomesFor("cohere/command-a", 4, 0, 0);
  assert.equal(toolSuccessRate("cohere/command-a"), null);
  const key = requestKey(convo);
  recordToolOutcome("dahl/MiniMax", "drop", key);
  assert.deepEqual(order(planToolTargets(pool, key)), order(pool));
  resetToolCallDrops();
});

test("the request key ignores transport options a retry may change", () => {
  assert.equal(requestKey({ ...convo, stream: true }), requestKey({ ...convo, stream: false, max_tokens: 5 }));
  assert.notEqual(requestKey(convo), requestKey({ ...convo, messages: [] }));
});
