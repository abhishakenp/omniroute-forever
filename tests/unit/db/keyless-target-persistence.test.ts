/**
 * C2/C3 — end-to-end proof that a keyless target's failure is now PERSISTED,
 * and that a retired credential no longer costs a request an attempt.
 *
 * Runs against a real SQLite in an isolated DATA_DIR (the pattern from
 * telemetry-auto-cleanup-6848.test.ts) so it exercises the true
 * `TargetIterator` + `getDbInstance()` path rather than a stub. Without the
 * DATA_DIR override this would mutate the developer's real
 * ~/.omniroute/storage.sqlite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-keyless-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SQLITE_FILE = path.join(TEST_DATA_DIR, "storage.sqlite");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("@/lib/db/core");
const { TargetIterator } = await import("@/lib/db/targetIterator");
const { loadKeylessHealth, loadIncapableModels, recordModelIncapable } = await import(
  "@/lib/db/keylessHealth"
);


// HARD GUARD: `bun test` runs several files in ONE process, and `getDbInstance()`
// is a singleton. If another test file imported core first, the singleton is
// already bound to the developer's REAL ~/.omniroute/storage.sqlite and the
// DATA_DIR assignment above has no effect — these tests would then mutate
// production data. (That is not hypothetical: it happened, and seven test rows
// had to be deleted out of the live database.) Refuse to run instead.
// The path comes from SQLite's own `PRAGMA database_list`, which is the
// authority on what this handle is actually bound to, regardless of adapter.
function assertIsolated(dbPath: string): void {
  // macOS resolves /var/folders/... to /private/var/folders/..., so compare
  // realpaths rather than the literal strings.
  const isolated = fs.realpathSync(TEST_DATA_DIR);
  if (!dbPath.startsWith(isolated) && !dbPath.startsWith(TEST_DATA_DIR)) {
    throw new Error(
      `REFUSING TO RUN: the DB singleton is bound to ${dbPath}, not the isolated ` +
        `${TEST_DATA_DIR}. Run this file on its own (bun test <file>) so it cannot ` +
        `write to the real database.`
    );
  }
}

const db = core.getDbInstance();
assertIsolated(
  String(
    (
      db.prepare("PRAGMA database_list").all() as Array<{ file?: string; name?: string }>
    ).find((r) => r.name === "main")?.file ?? ""
  )
);

function keylessRow(provider: string) {
  // bun:sqlite's .get() yields null for "no row"; normalise so the assertions
  // below can speak in terms of a single "absent" value.
  return (db
    .prepare(`SELECT value FROM key_value WHERE namespace = 'keylessProviderHealth' AND key = ?`)
    .get(provider) as { value: string } | null | undefined) ?? undefined;
}

test("REGRESSION: markFailed on a keyless target persists a cooldown", () => {
  // Before the fix, markFailed ran
  //   UPDATE provider_connections ... WHERE id = 'noauth-felo-web'
  // which matched no row. `changes` was 0 and the failure vanished — which is
  // why felo-web and duckduckgo-web accumulated ~21k 429s without ever cooling
  // down. Assert the state actually lands somewhere.
  assert.equal(keylessRow("felo-web"), undefined, "precondition: nothing recorded yet");

  const iterator = new TargetIterator({});
  iterator.markFailed("noauth-felo-web", 429, 60_000);

  const row = keylessRow("felo-web");
  assert.ok(row, "a keyless failure MUST persist — this is the whole bug");
  const parsed = JSON.parse(row.value) as { level: number; until: number };
  assert.equal(parsed.level, 1);
  assert.ok(parsed.until > Date.now(), "the provider must now be cooling down");
});

test("a keyless failure does NOT create a phantom provider_connections row", () => {
  const iterator = new TargetIterator({});
  iterator.markFailed("noauth-duckduckgo-web", 429, 60_000);
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM provider_connections WHERE id LIKE 'noauth-%'`)
    .get() as { n: number };
  assert.equal(count.n, 0, "keyless health must not pollute the credential table");
});

test("consecutive keyless failures escalate, and a success clears them", () => {
  const iterator = new TargetIterator({});
  iterator.markFailed("noauth-testprov", 429, 0);
  iterator.markFailed("noauth-testprov", 429, 0);
  const two = JSON.parse(keylessRow("testprov")!.value) as { level: number };
  assert.equal(two.level, 2);

  iterator.markSucceeded("noauth-testprov");
  assert.equal(
    keylessRow("testprov"),
    undefined,
    "a success must clear the backoff — a scraper that recovers comes straight back"
  );
});

test("a cooling-down keyless provider is visible to a freshly constructed iterator", () => {
  const first = new TargetIterator({});
  first.markFailed("noauth-coolprov", 429, 60 * 60_000);

  // A NEW iterator (i.e. the next request) must see the cooldown. Before the
  // fix there was nothing to see, so every request re-tried the provider.
  const health = loadKeylessHealth(db);
  assert.ok(health.get("coolprov"), "the next request must be able to see the cooldown");
  assert.ok((health.get("coolprov")?.until ?? 0) > Date.now());
});

test("markFailed on a REAL connection still writes to provider_connections", () => {
  // Guard against the keyless short-circuit swallowing credentialed failures.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, auth_type, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run("real-conn-1", "mistral", "apikey", now, now);

  const iterator = new TargetIterator({});
  iterator.markFailed("real-conn-1", 429, 60_000);

  const row = db
    .prepare(`SELECT rate_limited_until, last_error FROM provider_connections WHERE id = ?`)
    .get("real-conn-1") as { rate_limited_until: string | null; last_error: string | null };
  assert.ok(row.rate_limited_until, "a credentialed 429 must still cool the row down");
  assert.equal(row.last_error, "HTTP 429");
});

test("C3: a 'revoked' credential is not offered, so it costs a request no attempt", () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections
       (id, provider, auth_type, is_active, test_status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'revoked', ?, ?)`
  ).run("revoked-conn-1", "zzz-revoked-provider", "apikey", now, now);

  const iterator = new TargetIterator({ specificProvider: "zzz-revoked-provider" });
  const target = iterator.nextTarget();
  assert.equal(
    target,
    null,
    "a revoked row is terminal — it must never be handed to a live request"
  );
});

test("C3: an ACTIVE credential for the same provider is still offered", () => {
  // Proves the exclusion above is about `revoked`, not about the provider.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections
       (id, provider, auth_type, is_active, test_status, default_model, created_at, updated_at)
     VALUES (?, ?, ?, 1, NULL, ?, ?, ?)`
  ).run("live-conn-1", "zzz-revoked-provider", "apikey", "some-model", now, now);

  const iterator = new TargetIterator({ specificProvider: "zzz-revoked-provider" });
  const target = iterator.nextTarget();
  assert.ok(target, "a healthy row for the same provider must still be a candidate");
  assert.equal(target?.connectionId, "live-conn-1");
});

test("C2b: a model recorded as incapable is never offered again", () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections
       (id, provider, auth_type, is_active, default_model, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  ).run("incap-conn-1", "zzz-incapable-provider", "apikey", "transcribe-only", now, now);

  const before = new TargetIterator({ specificProvider: "zzz-incapable-provider" });
  assert.ok(before.nextTarget(), "precondition: the model is offered while nothing is known");

  recordModelIncapable(
    db,
    "zzz-incapable-provider/transcribe-only",
    "invalid request: model 'transcribe-only' is not supported"
  );
  assert.equal(loadIncapableModels(db).has("zzz-incapable-provider/transcribe-only"), true);

  const after = new TargetIterator({ specificProvider: "zzz-incapable-provider" });
  assert.equal(
    after.nextTarget(),
    null,
    "an upstream that says the model cannot chat must retire it from the pool"
  );
});

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
