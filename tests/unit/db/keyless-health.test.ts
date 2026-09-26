/**
 * Health tracking for keyless (`noauth-*`) targets, and permanent retirement of
 * models an upstream says cannot chat.
 *
 * The bugs these cover:
 *
 *  C2a — `TargetIterator.markFailed()` writes health with
 *        `UPDATE provider_connections ... WHERE id = ?`. A keyless target's id
 *        (`noauth-felo-web`) matches no row, so the UPDATE changed 0 rows and
 *        every failure was silently discarded. Nothing cooled down, and the
 *        `quarantinedProviders` guard could not help either — it is a
 *        `GROUP BY provider` over `provider_connections`, and a provider with
 *        zero rows produces no group. Measured: 10,613 felo-web and 10,423
 *        duckduckgo-web 429s, each request re-trying a scraper that had just
 *        been rate-limited.
 *
 *  C2b — `refusalReason()` has always classified
 *        `400 invalid request: model 'X'` as "model cannot chat", but the
 *        classification only decorated the final error message. The target
 *        stayed in the pool. Measured: 8,913 identical 400s for
 *        cohere/cohere-transcribe-03-2026, a speech-to-text model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";

const {
  loadKeylessHealth,
  recordKeylessFailure,
  clearKeylessFailure,
  loadIncapableModels,
  recordModelIncapable,
  isKeylessConnectionId,
  providerFromKeylessId,
  isModelIncapableRefusal,
  keylessBackoffMs,
} = await import("@/lib/db/keylessHealth");

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE key_value (
    namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (namespace, key)
  )`);
  return db;
}

test("a keyless connection id is recognised and its provider extracted", () => {
  assert.equal(isKeylessConnectionId("noauth-felo-web"), true);
  assert.equal(isKeylessConnectionId("abc-123-uuid"), false);
  assert.equal(providerFromKeylessId("noauth-duckduckgo-web"), "duckduckgo-web");
});

test("a keyless failure persists a cooldown — the regression that lost ~21k failures", () => {
  const db = makeDb();
  // Before the fix nothing was written anywhere for a noauth target.
  assert.equal(loadKeylessHealth(db).size, 0);

  const now = 1_000_000;
  const health = recordKeylessFailure(db, "felo-web", 0, now);
  assert.ok(health, "a failure must produce health state");
  assert.equal(health.level, 1);
  assert.equal(health.until, now + keylessBackoffMs(0));

  const loaded = loadKeylessHealth(db);
  assert.equal(loaded.get("felo-web")?.level, 1);
  assert.ok((loaded.get("felo-web")?.until ?? 0) > now, "must be cooling down");
});

test("consecutive keyless failures escalate the backoff", () => {
  const db = makeDb();
  const now = 1_000_000;
  const first = recordKeylessFailure(db, "duckduckgo-web", 0, now)!;
  const second = recordKeylessFailure(db, "duckduckgo-web", 0, now)!;
  const third = recordKeylessFailure(db, "duckduckgo-web", 0, now)!;

  assert.equal(first.level, 1);
  assert.equal(second.level, 2);
  assert.equal(third.level, 3);
  assert.ok(
    third.until - now > second.until - now && second.until - now > first.until - now,
    "each consecutive failure must cool down for longer"
  );
});

test("a caller-imposed cooldown floor wins when it is longer than the backoff", () => {
  const db = makeDb();
  const now = 1_000_000;
  const longFloor = 60 * 60_000; // 1h, longer than the level-0 backoff of 5min
  const health = recordKeylessFailure(db, "felo-web", longFloor, now)!;
  assert.equal(health.until, now + longFloor);
});

test("a keyless success clears the backoff — no headstones for a scraper that recovers", () => {
  const db = makeDb();
  recordKeylessFailure(db, "felo-web", 0, Date.now());
  assert.equal(loadKeylessHealth(db).size, 1);

  clearKeylessFailure(db, "felo-web");
  assert.equal(loadKeylessHealth(db).size, 0);
});

test("a malformed health row is ignored rather than throwing", () => {
  const db = makeDb();
  db.prepare(`INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)`).run(
    "keylessProviderHealth",
    "felo-web",
    "not json"
  );
  assert.equal(loadKeylessHealth(db).size, 0);
  // And recording over it still works, treating the prior as level 0.
  assert.equal(recordKeylessFailure(db, "felo-web", 0, 1000)!.level, 1);
});

test("health tracking never throws when the table is missing", () => {
  const db = new Database(":memory:");
  assert.equal(loadKeylessHealth(db).size, 0);
  assert.equal(recordKeylessFailure(db, "felo-web"), null);
  assert.doesNotThrow(() => clearKeylessFailure(db, "felo-web"));
  assert.equal(loadIncapableModels(db).size, 0);
  assert.doesNotThrow(() => recordModelIncapable(db, "a/b", "x"));
});

// ── C2b: permanent retirement of a model that cannot chat ───────────────────

test("'invalid request: model' is recognised as a permanent incapability", () => {
  assert.equal(
    isModelIncapableRefusal(
      400,
      `{"id":"x","message":"invalid request: model 'cohere-transcribe-03-2026' is not supported"}`
    ),
    true
  );
  assert.equal(isModelIncapableRefusal(400, "TOOL_USE_NOT_SUPPORTED"), true);
  assert.equal(isModelIncapableRefusal(404, "model_not_found"), true);
});

test("a size refusal is NOT treated as a permanent incapability", () => {
  // This belongs to recordTokenRefusal(), which is size-aware and reversible.
  // Marking the model permanently dead here would retire a healthy model.
  assert.equal(isModelIncapableRefusal(400, `{"error_type":"TOO_MANY_TOKENS"}`), false);
  assert.equal(isModelIncapableRefusal(400, "context length exceeded"), false);
  assert.equal(isModelIncapableRefusal(400, "input is too long"), false);
});

test("an ordinary 400 does not retire a model", () => {
  // A 400 is usually the caller's fault. Retiring a healthy model because one
  // malformed request was sent to it is the headstone mistake, again.
  assert.equal(isModelIncapableRefusal(400, "malformed json body"), false);
  assert.equal(isModelIncapableRefusal(429, "invalid request: model 'x'"), false);
  assert.equal(isModelIncapableRefusal(500, "invalid request: model 'x'"), false);
  assert.equal(isModelIncapableRefusal(400, ""), false);
});

test("an incapable model is recorded and reloaded", () => {
  const db = makeDb();
  assert.equal(loadIncapableModels(db).size, 0);
  recordModelIncapable(db, "cohere/cohere-transcribe-03-2026", "invalid request: model");
  const loaded = loadIncapableModels(db);
  assert.equal(loaded.has("cohere/cohere-transcribe-03-2026"), true);
  assert.equal(loaded.size, 1);
  // Idempotent — recording twice does not duplicate.
  recordModelIncapable(db, "cohere/cohere-transcribe-03-2026", "again");
  assert.equal(loadIncapableModels(db).size, 1);
});
