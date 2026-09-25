/**
 * An empty or truncated /v1/chat/completions body is a 400 in the OpenAI error
 * shape, not the 500 "Gateway error" that `request.json()` throwing produced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseChatBody } from "../../src/server/headless/parseChatBody.ts";

const post = (body?: string) =>
  new Request("http://x/v1/chat/completions", { method: "POST", body, headers: { "content-type": "application/json" } });

const rejected = async (body?: string): Promise<string> => {
  const parsed = await parseChatBody(post(body));
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.response.status, 400);
  const json = (await parsed.response.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "invalid_request_error");
  return json.error.message;
};

test("a missing body is a 400", async () => assert.match(await rejected(), /empty/));
test("a whitespace-only body is a 400", async () => assert.match(await rejected("  \n"), /empty/));
test("a truncated body is a 400", async () =>
  assert.match(await rejected('{"model":"auto/best-free","mess'), /not valid JSON/));
test("a JSON value that is not an object is a 400", async () => {
  assert.match(await rejected("[1,2]"), /JSON object/);
  assert.match(await rejected("null"), /JSON object/);
});
test("a normal body is accepted", async () => {
  const parsed = await parseChatBody(post('{"model":"auto/best-free","messages":[]}'));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.body.model, "auto/best-free");
});
