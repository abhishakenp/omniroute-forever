/**
 * C7 — telemetry must be retainable as a bounded window rather than wiped.
 *
 * `purgeCallLogs()` ran a bare `DELETE FROM call_logs`, leaving the router with
 * zero request-level history. It now accepts a retention floor: with
 * `keepRecent > 0` (or `CALL_LOGS_PURGE_KEEP_RECENT` set) it trims to the N most
 * recent rows instead of emptying the table, so no automated path can leave the
 * router with no telemetry at all.
 *
 * The default is unchanged (0 = purge everything), because an operator who
 * explicitly asks to purge request history must still get an empty table.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SQLITE_FILE = path.join(TEST_DATA_DIR, "storage.sqlite");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("@/lib/db/core");
const cleanup = await import("@/lib/db/cleanup");


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

function seed(n: number) {
  db.prepare("DELETE FROM call_logs").run();
  for (let i = 0; i < n; i++) {
    // Ascending timestamps: index 0 oldest, n-1 newest.
    db.prepare(`INSERT INTO call_logs (id, timestamp) VALUES (?, ?)`).run(
      `call-${String(i).padStart(4, "0")}`,
      new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
    );
  }
}

const count = () => (db.prepare("SELECT COUNT(*) AS n FROM call_logs").get() as { n: number }).n;

test("the default still purges everything — an explicit purge stays a purge", async () => {
  seed(10);
  const result = await cleanup.purgeCallLogs();
  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 10);
  assert.equal(count(), 0);
});

test("REGRESSION: keepRecent retains a bounded window instead of wiping", async () => {
  seed(10);
  const result = await cleanup.purgeCallLogs({ keepRecent: 3 });
  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 7);
  assert.equal(count(), 3, "telemetry must survive — this is the whole point");
});

test("the rows retained are the MOST RECENT ones", async () => {
  seed(10);
  await cleanup.purgeCallLogs({ keepRecent: 3 });
  const ids = (db.prepare("SELECT id FROM call_logs ORDER BY timestamp").all() as Array<{
    id: string;
  }>).map((r) => r.id);
  assert.deepEqual(ids, ["call-0007", "call-0008", "call-0009"]);
});

test("keepRecent larger than the table is a no-op", async () => {
  seed(4);
  const result = await cleanup.purgeCallLogs({ keepRecent: 100 });
  assert.equal(result.deleted, 0);
  assert.equal(count(), 4);
});

test("CALL_LOGS_PURGE_KEEP_RECENT configures the floor without a code change", async () => {
  const saved = process.env.CALL_LOGS_PURGE_KEEP_RECENT;
  try {
    process.env.CALL_LOGS_PURGE_KEEP_RECENT = "5";
    assert.equal(cleanup.getCallLogPurgeKeepRecent(), 5);

    seed(12);
    const result = await cleanup.purgeCallLogs();
    assert.equal(result.deleted, 7);
    assert.equal(count(), 5, "the env floor must apply to a purge with no explicit option");
  } finally {
    if (saved === undefined) delete process.env.CALL_LOGS_PURGE_KEEP_RECENT;
    else process.env.CALL_LOGS_PURGE_KEEP_RECENT = saved;
  }
});

test("an invalid or absent env value falls back to purge-everything", () => {
  const saved = process.env.CALL_LOGS_PURGE_KEEP_RECENT;
  try {
    delete process.env.CALL_LOGS_PURGE_KEEP_RECENT;
    assert.equal(cleanup.getCallLogPurgeKeepRecent(), 0);
    process.env.CALL_LOGS_PURGE_KEEP_RECENT = "nonsense";
    assert.equal(cleanup.getCallLogPurgeKeepRecent(), 0);
    process.env.CALL_LOGS_PURGE_KEEP_RECENT = "-4";
    assert.equal(cleanup.getCallLogPurgeKeepRecent(), 0);
  } finally {
    if (saved === undefined) delete process.env.CALL_LOGS_PURGE_KEEP_RECENT;
    else process.env.CALL_LOGS_PURGE_KEEP_RECENT = saved;
  }
});

test("the scheduled cleanup path was ALREADY time-bounded and stays that way", async () => {
  // Worth pinning: cleanupCallLogs() deletes only rows older than the retention
  // window. It is NOT the unconditional wipe, and must not become one.
  seed(5);
  // All seeded rows are from 2026-01-01, far outside any sane retention window,
  // so they are all older than the cutoff and should all go — but via a
  // timestamp predicate, leaving newer rows alone.
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO call_logs (id, timestamp) VALUES (?, ?)`).run("fresh-1", now);

  const result = await cleanup.cleanupCallLogs();
  assert.equal(result.errors, 0);
  const remaining = (db.prepare("SELECT id FROM call_logs").all() as Array<{ id: string }>).map(
    (r) => r.id
  );
  assert.deepEqual(remaining, ["fresh-1"], "recent telemetry must be preserved by the scheduler");
});

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
