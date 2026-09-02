/**
 * TargetIterator recovery/backoff unit tests.
 *
 * Covers the "permanent poison" class of bug: a 401 used to write
 * `test_status='error'` with a NULL cooldown, which the candidate filter
 * excludes forever — nothing in the Bun daemon ever cleared it and it survived
 * restarts, so a rotated or briefly-broken key was dead for good.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";

const { softBackoffMs, reviveCooldownlessSoftFailures, LEGACY_SOFT_FAILURE_BACKOFF_LEVEL } =
  await import("@/lib/db/targetIterator");

// ─── Backoff schedule ────────────────────────────────────────────────────────

test("softBackoffMs escalates geometrically from 5 minutes", () => {
  assert.equal(softBackoffMs(0), 5 * 60_000);
  assert.equal(softBackoffMs(1), 10 * 60_000);
  assert.equal(softBackoffMs(2), 20 * 60_000);
  assert.equal(softBackoffMs(4), 80 * 60_000);
});

test("softBackoffMs caps at 12h and never returns 0 for absurd input", () => {
  const cap = 12 * 60 * 60_000;
  assert.equal(softBackoffMs(10), cap);
  assert.equal(softBackoffMs(1_000), cap, "a huge level must clamp, not overflow the shift to 0");
  assert.equal(softBackoffMs(-5), 5 * 60_000);
  assert.equal(softBackoffMs(Number.NaN), 5 * 60_000);
});

// ─── Legacy revival ──────────────────────────────────────────────────────────

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER DEFAULT 1,
    test_status TEXT, backoff_level INTEGER DEFAULT 0, rate_limited_until TEXT
  )`);
  return db;
}

function insert(
  db: Database,
  id: string,
  status: string | null,
  cooldown: string | null,
  level = 0
) {
  db.run(
    `INSERT INTO provider_connections (id, provider, test_status, backoff_level, rate_limited_until)
     VALUES (?, 'p', ?, ?, ?)`,
    [id, status, level, cooldown]
  );
}

test("reviveCooldownlessSoftFailures gives poisoned rows a cooldown and a back-of-queue backoff", () => {
  const db = makeDb();
  insert(db, "poisoned", "error", null);
  insert(db, "stale-unavailable", "unavailable", null);

  const changed = reviveCooldownlessSoftFailures(db as never);
  assert.equal(changed, 2);

  for (const id of ["poisoned", "stale-unavailable"]) {
    const row = db.query(`SELECT * FROM provider_connections WHERE id = ?`).get(id) as {
      backoff_level: number;
      rate_limited_until: string;
      test_status: string;
    };
    assert.equal(row.backoff_level, LEGACY_SOFT_FAILURE_BACKOFF_LEVEL);
    assert.ok(row.rate_limited_until, "must get a cooldown — that is the way back");
    assert.ok(
      new Date(row.rate_limited_until).getTime() > Date.now(),
      "cooldown must be in the future so it is retried later, not immediately"
    );
    assert.ok(row.test_status, "status is left in place; the cooldown is what expires");
  }
});

test("reviveCooldownlessSoftFailures never touches terminal or already-cooling rows", () => {
  const db = makeDb();
  insert(db, "terminal", "credits_exhausted", null);
  insert(db, "banned", "banned", null);
  insert(db, "expired", "expired", null);
  const existing = new Date(Date.now() + 999_000).toISOString();
  insert(db, "cooling", "error", existing, 2);
  insert(db, "healthy", null, null);

  const changed = reviveCooldownlessSoftFailures(db as never);
  assert.equal(changed, 0, "nothing here is a cooldown-less soft failure");

  const cooling = db.query(`SELECT * FROM provider_connections WHERE id = 'cooling'`).get() as {
    rate_limited_until: string;
    backoff_level: number;
  };
  assert.equal(cooling.rate_limited_until, existing, "an in-flight cooldown must not be extended");
  assert.equal(cooling.backoff_level, 2);
});

test("reviveCooldownlessSoftFailures is idempotent", () => {
  const db = makeDb();
  insert(db, "poisoned", "error", null);
  assert.equal(reviveCooldownlessSoftFailures(db as never), 1);
  assert.equal(reviveCooldownlessSoftFailures(db as never), 0, "second run must be a no-op");
});

test("reviveCooldownlessSoftFailures raises but never lowers an existing backoff level", () => {
  const db = makeDb();
  insert(db, "deep", "error", null, LEGACY_SOFT_FAILURE_BACKOFF_LEVEL + 3);
  reviveCooldownlessSoftFailures(db as never);
  const row = db
    .query(`SELECT backoff_level FROM provider_connections WHERE id = 'deep'`)
    .get() as {
    backoff_level: number;
  };
  assert.equal(row.backoff_level, LEGACY_SOFT_FAILURE_BACKOFF_LEVEL + 3);
});

// ─── Free-provider resolution ────────────────────────────────────────────────

const { getFreeProviderIds, __resetFreeProviderIds } = await import("@/lib/db/targetIterator");

test("getFreeProviderIds includes the providers the old hardcoded list forgot", () => {
  __resetFreeProviderIds();
  const free = getFreeProviderIds();
  // Every one of these is free, is configured here, and was ABSENT from the
  // hardcoded FREE_PROVIDERS set that used to sit unused in thinGateway.ts.
  for (const id of ["dahl", "llm7", "uncloseai", "bazaarlink"]) {
    assert.ok(free.has(id), `${id} is free and must survive a best-free filter`);
  }
});

test("getFreeProviderIds keeps the keyless local passthroughs", () => {
  __resetFreeProviderIds();
  const free = getFreeProviderIds();
  // auggie is `hasFree: false` in the catalog (the Augment subscription is
  // paid) but costs the router nothing to call, so authType:"none" must carry it.
  assert.ok(free.has("auggie"), "local CLI passthrough must be reachable from best-free");
  assert.ok(free.has("duckduckgo-web"));
  assert.ok(free.has("felo-web"));
});

test("getFreeProviderIds keeps the big free API providers", () => {
  __resetFreeProviderIds();
  const free = getFreeProviderIds();
  for (const id of ["mistral", "cohere", "openrouter", "api-airforce", "pollinations"]) {
    assert.ok(free.has(id), `${id} must be considered free`);
  }
});
