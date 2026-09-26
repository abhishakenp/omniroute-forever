/**
 * Retirement of credentials that are dead rather than merely broken.
 *
 * The bug these cover: `deleteDeadAccount` asks the *provisioner* to forget a
 * key and never touches OmniRoute's own `provider_connections`, so a revoked
 * credential stayed `is_active = 1` and kept being handed to live requests
 * forever. Measured before the fix: 355 such rows, 215 on mistral alone, some
 * at `backoff_level` 30 — every one of them spending an attempt out of the
 * 60-second budget a real request gets before it is answered with a 503.
 *
 * The opposite mistake is covered too. Quota exhaustion must keep its way back,
 * because a free tier resets on a clock; killing those rows is what collapsed
 * this pool to two providers once already.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";

const { candidates, retire, revive } = await import("@/lib/db/retireRevoked");
const { AUTH_DEAD_AFTER_LEVEL } = await import("@/lib/db/targetIterator");

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER DEFAULT 1,
    test_status TEXT, backoff_level INTEGER DEFAULT 0,
    rate_limited_until TEXT, last_error TEXT, last_error_at TEXT
  )`);
  return db;
}

function insert(
  db: Database,
  id: string,
  row: Partial<{
    provider: string;
    test_status: string | null;
    backoff_level: number;
    rate_limited_until: string | null;
    last_error: string | null;
  }> = {}
) {
  db.prepare(
    `INSERT INTO provider_connections
       (id, provider, test_status, backoff_level, rate_limited_until, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    row.provider ?? "mistral",
    row.test_status ?? null,
    row.backoff_level ?? 0,
    row.rate_limited_until ?? null,
    row.last_error ?? null
  );
}

const statusOf = (db: Database, id: string) =>
  (
    db.prepare(`SELECT test_status FROM provider_connections WHERE id = ?`).get(id) as {
      test_status: string | null;
    }
  ).test_status;

// ─── What counts as dead ─────────────────────────────────────────────────────

test("a key past the consecutive-auth-failure threshold is retired", () => {
  const db = makeDb();
  insert(db, "dead", {
    test_status: "error",
    backoff_level: AUTH_DEAD_AFTER_LEVEL,
    last_error: "HTTP 401",
  });

  assert.equal(candidates(db).length, 1, "dry run must see it before the write does");
  assert.equal(retire(db), 1);
  assert.equal(statusOf(db, "dead"), "revoked");
});

test("a key one failure short of the threshold keeps its way back", () => {
  const db = makeDb();
  insert(db, "recoverable", {
    test_status: "error",
    backoff_level: AUTH_DEAD_AFTER_LEVEL - 1,
    last_error: "HTTP 401",
  });

  assert.equal(candidates(db).length, 0);
  assert.equal(retire(db), 0);
  assert.equal(statusOf(db, "recoverable"), "error", "still soft — a rotation can still fix it");
});

test("quota exhaustion is never retired, however long it has been failing", () => {
  const db = makeDb();
  // Far past the auth threshold, and irrelevant: a free tier's quota resets on
  // a clock. Retiring these is the regression this assertion exists to catch.
  insert(db, "broke", {
    provider: "openrouter",
    test_status: "credits_exhausted",
    backoff_level: 40,
    last_error: "HTTP 402",
  });

  assert.equal(candidates(db).length, 0);
  assert.equal(retire(db), 0);
  assert.equal(statusOf(db, "broke"), "credits_exhausted");
});

test("a row whose most recent failure was not an auth rejection is left alone", () => {
  const db = makeDb();
  // Ten auth failures then a 500. The last thing known about this connection is
  // not an auth verdict, so it is not evidence the credential is gone.
  insert(db, "server-error", {
    test_status: "error",
    backoff_level: AUTH_DEAD_AFTER_LEVEL + 5,
    last_error: "HTTP 500",
  });

  assert.equal(candidates(db).length, 0);
  assert.equal(retire(db), 0);
});

test("a healthy connection is untouched", () => {
  const db = makeDb();
  insert(db, "healthy", { test_status: null, backoff_level: 0 });
  assert.equal(retire(db), 0);
  assert.equal(statusOf(db, "healthy"), null);
});

// ─── The iterator must never select a retired row ────────────────────────────

test("'revoked' is a terminal status, so the candidate filter excludes it", async () => {
  // The candidate predicate is built from TERMINAL_STATUSES once at module
  // load, so asserting on the exported threshold would not prove the SQL
  // changed. Read the shipped source and check the status is in the list the
  // predicate is built from — if it is not, a retired key is still selectable
  // and the whole retirement is decorative.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../../../src/lib/db/targetIterator.ts", import.meta.url)),
    "utf8"
  );
  assert.match(
    source,
    /TERMINAL_STATUSES = \[[^\]]*"revoked"/,
    "revoked must be in TERMINAL_STATUSES or retired keys are still selectable"
  );
  assert.match(
    source,
    /test_status NOT IN \(\$\{sqlList\(TERMINAL_STATUSES\)\}\)/,
    "the candidate predicate must exclude terminal statuses"
  );
});

// ─── Reversibility ───────────────────────────────────────────────────────────

test("revive restores a retired key with a clean slate", () => {
  const db = makeDb();
  insert(db, "rotated", {
    test_status: "revoked",
    backoff_level: 30,
    last_error: "HTTP 401",
  });

  assert.equal(revive(db), 1);
  const row = db
    .prepare(`SELECT test_status, backoff_level, rate_limited_until FROM provider_connections WHERE id = ?`)
    .get("rotated") as { test_status: string | null; backoff_level: number; rate_limited_until: string | null };

  assert.equal(row.test_status, null);
  assert.equal(row.backoff_level, 0, "a revived key must not be one failure from the grave again");
  assert.equal(row.rate_limited_until, null);
});

test("revive can be scoped to one provider", () => {
  const db = makeDb();
  insert(db, "m", { provider: "mistral", test_status: "revoked" });
  insert(db, "o", { provider: "openrouter", test_status: "revoked" });

  assert.equal(revive(db, "mistral"), 1);
  assert.equal(statusOf(db, "m"), null);
  assert.equal(statusOf(db, "o"), "revoked", "other providers must be untouched");
});
