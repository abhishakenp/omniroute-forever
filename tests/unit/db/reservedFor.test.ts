/**
 * Tests for the reserved-alias routing invariant (migration 143 + TargetIterator).
 *
 * `provider_connections.reserved_for` tags a connection with the ONE consumer
 * allowed to spend it. The invariant has two halves and both are load-bearing:
 *
 *  - A request WITHOUT a tag must never be offered a reserved connection.
 *    (Otherwise general traffic drains the key that was set aside.)
 *  - A request WITH a tag sees its own reserved connections FIRST, and the
 *    general pool only as fallback.
 *
 * Ordering is proved against the priority column deliberately inverted: the
 * general rows carry HIGHER priority than the reserved ones, so if the
 * `(reserved_for IS NOT NULL) DESC` ordering term were dropped the general
 * rows would sort first and this test would fail.
 *
 * Runs against a throwaway DATA_DIR — never the operator's real storage.sqlite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reserved-for-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const { TargetIterator } = await import("../../../src/lib/db/targetIterator.ts");
const { runMigrations } = await import("../../../src/lib/db/migrationRunner.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");

const RESERVED_TAG = "iris/always";

interface Seed {
  id: string;
  provider: string;
  model: string;
  priority: number;
  reservedFor: string | null;
}

// Distinct provider per row: the iterator de-duplicates candidates by
// `provider:modelId`, so two rows sharing a provider+model would collapse into
// one target and the counts below would be meaningless.
const SEEDS: Seed[] = [
  { id: "res-1", provider: "resprov1", model: "res-model-1", priority: 1, reservedFor: RESERVED_TAG },
  { id: "res-2", provider: "resprov2", model: "res-model-2", priority: 1, reservedFor: RESERVED_TAG },
  { id: "gen-1", provider: "genprov1", model: "gen-model-1", priority: 9, reservedFor: null },
  { id: "gen-2", provider: "genprov2", model: "gen-model-2", priority: 9, reservedFor: null },
  { id: "gen-3", provider: "genprov3", model: "gen-model-3", priority: 9, reservedFor: null },
  { id: "oth-1", provider: "othprov1", model: "oth-model-1", priority: 9, reservedFor: "other/thing" },
];

const RESERVED_IDS = SEEDS.filter((s) => s.reservedFor === RESERVED_TAG).map((s) => s.id);
const GENERAL_IDS = SEEDS.filter((s) => s.reservedFor === null).map((s) => s.id);
const FOREIGN_IDS = SEEDS.filter(
  (s) => s.reservedFor !== null && s.reservedFor !== RESERVED_TAG
).map((s) => s.id);

function seedConnections() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO provider_connections
       (id, provider, auth_type, api_key, default_model, priority, is_active,
        backoff_level, reserved_for, created_at, updated_at)
     VALUES (?, ?, 'api_key', ?, ?, ?, 1, 0, ?, ?, ?)`
  );
  for (const s of SEEDS) {
    insert.run(s.id, s.provider, `key-${s.id}`, s.model, s.priority, s.reservedFor, now, now);
  }
}

/**
 * Drain the iterator's *connection* phase. Once the iterator falls through to
 * the keyless registry fallback (`noauth-*` ids) there are no more
 * provider_connections rows on offer, so that is the stop signal.
 */
function drainConnectionTargets(iterator: InstanceType<typeof TargetIterator>): string[] {
  const seen: string[] = [];
  for (let i = 0; i < 100; i++) {
    const target = iterator.nextTarget();
    if (!target) break;
    if (target.connectionId.startsWith("noauth-")) break;
    seen.push(target.connectionId);
  }
  return seen;
}

test.before(() => {
  core.resetDbInstance();
  core.getDbInstance(); // runs migrations, including 143
  seedConnections();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("migration 143 adds reserved_for to provider_connections", () => {
  const db = core.getDbInstance();
  const columns = (
    db.prepare("PRAGMA table_info(provider_connections)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(columns.includes("reserved_for"), `reserved_for missing; got ${columns.join(",")}`);
});

test("migration 143 creates the reserved_for index", () => {
  const db = core.getDbInstance();
  const indexes = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all("provider_connections") as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(
    indexes.includes("idx_provider_connections_reserved_for"),
    `index missing; got ${indexes.join(",")}`
  );
});

test("migration 143 is idempotent — re-running does not throw", () => {
  const db = core.getDbInstance();
  // Forget that 143 ran, so the runner re-attempts the ALTER TABLE against a
  // table that already has the column. The runner must absorb the resulting
  // "duplicate column name" and re-mark it applied rather than blowing up boot.
  db.prepare("DELETE FROM _omniroute_migrations WHERE version = ?").run("143");
  assert.doesNotThrow(() => runMigrations(db));
  const row = db
    .prepare("SELECT version FROM _omniroute_migrations WHERE version = ?")
    .get("143") as { version: string } | undefined;
  assert.ok(row, "143 should be marked applied again after the re-run");
});

test("tagged request: reserved connections come first, general pool is the fallback", () => {
  const iterator = new TargetIterator({ reservedFor: RESERVED_TAG });
  const seen = drainConnectionTargets(iterator);

  const reservedSlice = seen.slice(0, RESERVED_IDS.length);
  assert.deepEqual(
    [...reservedSlice].sort(),
    [...RESERVED_IDS].sort(),
    `expected the ${RESERVED_IDS.length} reserved rows first, got ${seen.join(",")}`
  );

  const rest = seen.slice(RESERVED_IDS.length);
  assert.deepEqual(
    [...rest].sort(),
    [...GENERAL_IDS].sort(),
    `expected the general pool as fallback, got ${rest.join(",")}`
  );

  for (const foreign of FOREIGN_IDS) {
    assert.ok(
      !seen.includes(foreign),
      `a connection reserved for another consumer leaked into ${RESERVED_TAG}: ${foreign}`
    );
  }
});

test("untagged request: reserved connections are invisible", () => {
  const iterator = new TargetIterator();
  const seen = drainConnectionTargets(iterator);

  assert.deepEqual(
    [...seen].sort(),
    [...GENERAL_IDS].sort(),
    `general traffic must see only the general pool, got ${seen.join(",")}`
  );
  for (const reserved of [...RESERVED_IDS, ...FOREIGN_IDS]) {
    assert.ok(!seen.includes(reserved), `reserved connection spent by general traffic: ${reserved}`);
  }
});

test("reservedFor survives create → unrelated update → explicit clear", async () => {
  const db = core.getDbInstance();
  const created = await providersDb.createProviderConnection({
    provider: "roundtripprov",
    authType: "api_key",
    apiKey: "rt-key",
    name: "roundtrip",
    defaultModel: "rt-model",
    reservedFor: RESERVED_TAG,
    isActive: false, // keep it out of the routing assertions above
  });
  assert.ok(created, "createProviderConnection should return the row");
  const read = (id: string) =>
    (db.prepare("SELECT reserved_for FROM provider_connections WHERE id = ?").get(id) as {
      reserved_for: string | null;
    }).reserved_for;

  // The create path builds its row from an explicit optional-field whitelist —
  // a column missing from that list is silently dropped, which is exactly how
  // this one was lost the first time.
  assert.equal(read(created.id), RESERVED_TAG, "create must persist the tag");

  // An UPDATE writes every column, so a patch touching an unrelated field must
  // not blank the reservation.
  await providersDb.updateProviderConnection(created.id, { name: "renamed" });
  assert.equal(read(created.id), RESERVED_TAG, "unrelated update must preserve the tag");

  await providersDb.updateProviderConnection(created.id, { reservedFor: null });
  assert.equal(read(created.id), null, "explicit null must return the row to the general pool");
});
