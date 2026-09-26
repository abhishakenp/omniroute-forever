/**
 * C6 — `/v1/models` must not rebuild a 150 KB catalogue on every request.
 *
 * The bug: the handler served by the headless Bun gateway
 * (src/app/api/v1/models/route.ts) queried SQLite, `JSON.parse`d every
 * provider's synced-model blob, built ~1,400 objects and `JSON.stringify`d the
 * result — per request, with no memoisation. It never consulted `catalogCache`
 * (that cache fronts different routes).
 *
 * Two further defects fell out of the same code and are covered here:
 *   - `created: Date.now()` per model per request made the body differ on every
 *     request, defeating ETag/conditional requests entirely;
 *   - synced and registry models were both appended, emitting duplicate ids.
 *
 * The fix must also invalidate PRECISELY: a connection write that does not
 * change which models exist (a `rate_limited_until` stamp, of which there are
 * hundreds an hour) must NOT cost a rebuild.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.SQLITE_FILE = path.join(TEST_DATA_DIR, "storage.sqlite");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("@/lib/db/core");
const route = await import("@/app/api/v1/models/route");


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

function addConnection(id: string, provider: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO provider_connections (id, provider, auth_type, is_active, created_at, updated_at)
     VALUES (?, ?, 'apikey', 1, ?, ?)`
  ).run(id, provider, now, now);
}

function setSyncedModels(provider: string, ids: string[]) {
  db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
  ).run(provider, JSON.stringify(ids.map((id) => ({ id }))));
}

addConnection("c1", "zzz-alpha");
setSyncedModels("zzz-alpha", ["m1", "m2", "m3"]);

test("the catalogue is served and contains the seeded models", async () => {
  route.__resetModelCatalogCache();
  const res = await route.GET(new Request("http://localhost/v1/models"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
  assert.equal(body.object, "list");
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes("zzz-alpha/m1"));
  assert.ok(ids.includes("auto/best-free"));
});

test("REGRESSION: repeated requests do NOT rebuild the catalogue", async () => {
  route.__resetModelCatalogCache();
  await route.GET(new Request("http://localhost/v1/models"));
  const after1 = route.__modelCatalogRebuildCount();

  for (let i = 0; i < 25; i++) await route.GET(new Request("http://localhost/v1/models"));

  assert.equal(
    route.__modelCatalogRebuildCount(),
    after1,
    "25 further requests must cost ZERO rebuilds — the old handler rebuilt 25 times"
  );
});

test("REGRESSION: the body is byte-identical across requests", async () => {
  // `created: Date.now()` per model made every response differ, so no ETag or
  // downstream cache could ever hit.
  route.__resetModelCatalogCache();
  const a = await (await route.GET(new Request("http://localhost/v1/models"))).text();
  const b = await (await route.GET(new Request("http://localhost/v1/models"))).text();
  assert.equal(a, b, "an unchanged catalogue must serialise identically");
});

test("a connection write that does not change the model list costs no rebuild", async () => {
  // This is the precision requirement. `rate_limited_until` churns constantly
  // and says nothing about which models exist.
  route.__resetModelCatalogCache();
  await route.GET(new Request("http://localhost/v1/models"));
  const before = route.__modelCatalogRebuildCount();

  db.prepare(`UPDATE provider_connections SET rate_limited_until = ? WHERE id = ?`).run(
    new Date(Date.now() + 60_000).toISOString(),
    "c1"
  );
  db.prepare(`UPDATE provider_connections SET backoff_level = 7 WHERE id = ?`).run("c1");
  db.prepare(`UPDATE provider_connections SET last_error = 'HTTP 429' WHERE id = ?`).run("c1");

  await route.GET(new Request("http://localhost/v1/models"));
  assert.equal(
    route.__modelCatalogRebuildCount(),
    before,
    "a backoff/cooldown write must NOT invalidate the catalogue"
  );
});

test("a write that DOES change the model list rebuilds", async () => {
  route.__resetModelCatalogCache();
  await route.GET(new Request("http://localhost/v1/models"));
  const before = route.__modelCatalogRebuildCount();

  setSyncedModels("zzz-alpha", ["m1", "m2", "m3", "m4-brand-new"]);

  const res = await route.GET(new Request("http://localhost/v1/models"));
  assert.equal(route.__modelCatalogRebuildCount(), before + 1, "a real change must rebuild");
  const body = (await res.json()) as { data: Array<{ id: string }> };
  assert.ok(
    body.data.some((m) => m.id === "zzz-alpha/m4-brand-new"),
    "the new model must be visible"
  );
});

test("activating a new provider rebuilds", async () => {
  route.__resetModelCatalogCache();
  await route.GET(new Request("http://localhost/v1/models"));
  const before = route.__modelCatalogRebuildCount();

  addConnection("c2", "zzz-beta");
  setSyncedModels("zzz-beta", ["b1"]);

  const res = await route.GET(new Request("http://localhost/v1/models"));
  assert.equal(route.__modelCatalogRebuildCount(), before + 1);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  assert.ok(body.data.some((m) => m.id === "zzz-beta/b1"));
});

test("REGRESSION: no duplicate model ids", async () => {
  route.__resetModelCatalogCache();
  const res = await route.GET(new Request("http://localhost/v1/models"));
  const body = (await res.json()) as { data: Array<{ id: string }> };
  const ids = body.data.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "the old handler emitted duplicates");
});

test("a matching If-None-Match gets 304 and no body", async () => {
  route.__resetModelCatalogCache();
  const first = await route.GET(new Request("http://localhost/v1/models"));
  const etag = first.headers.get("etag");
  assert.ok(etag, "an ETag must be published");

  const second = await route.GET(
    new Request("http://localhost/v1/models", { headers: { "If-None-Match": etag } })
  );
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("a stale If-None-Match still gets the full body", async () => {
  route.__resetModelCatalogCache();
  const res = await route.GET(
    new Request("http://localhost/v1/models", { headers: { "If-None-Match": 'W/"stale"' } })
  );
  assert.equal(res.status, 200);
  assert.ok((await res.text()).length > 0);
});

test("a corrupt synced blob does not take the catalogue down", async () => {
  db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`
  ).run("zzz-corrupt", "{not json");
  addConnection("c3", "zzz-corrupt");

  route.__resetModelCatalogCache();
  const res = await route.GET(new Request("http://localhost/v1/models"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  assert.ok(body.data.some((m) => m.id === "zzz-alpha/m1"), "other providers survive");
});

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
