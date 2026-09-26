// Z.AI's free-tier glm pool answers 429 code 1305 ("The service may be
// temporarily overloaded") on backend contention, not on a per-account quota.
// It must cost a flat 10s connection cooldown — not the default apikey backoff
// that grows on every repeat — so combo routing moves on and comes back soon.
import test from "node:test";
import assert from "node:assert/strict";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import { getProviderErrorRuleMatch } from "../../open-sse/config/providerErrorRules.ts";

const BODY = JSON.stringify({
  error: { code: "1305", message: "The service may be temporarily overloaded, please try again later" },
});

test("zai 429 code 1305 → flat 10s model_capacity cooldown from checkFallbackError", () => {
  const first = checkFallbackError(429, BODY, 0, "glm-4.7-flash", "zai");
  const repeated = checkFallbackError(429, BODY, 5, "glm-4.7-flash", "zai");
  assert.equal(first.shouldFallback, true);
  assert.equal(first.cooldownMs, 10_000);
  assert.equal(first.reason, "model_capacity");
  assert.equal(repeated.cooldownMs, 10_000, "repeats must not grow the cooldown");
});

test("zai provider rule matches the 1305 body and scopes the lock to the connection", () => {
  const match = getProviderErrorRuleMatch("zai", 429, null, JSON.parse(BODY));
  assert.ok(match, "rule should match");
  assert.equal(match?.cooldownMs, 10_000);
  assert.equal(match?.scope, "connection");
});

test("zai rule leaves other 429s and other providers alone", () => {
  const plain = JSON.stringify({ error: { message: "rate limit exceeded" } });
  assert.equal(getProviderErrorRuleMatch("zai", 429, null, JSON.parse(plain)), null);
  assert.equal(getProviderErrorRuleMatch("zai", 500, null, JSON.parse(BODY)), null);
  assert.notEqual(checkFallbackError(429, BODY, 0, "some-model", "openai").cooldownMs, undefined);
});
