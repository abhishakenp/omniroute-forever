/**
 * Local provider base-URL routing through the thin gateway.
 *
 * The bug: local providers (vllm, ollama-local, lm-studio, llama-cpp, …) are
 * registered in LOCAL_PROVIDERS for the dashboard but NOT in the OpenSSE
 * routing REGISTRY. The thin gateway's tryTarget() looked up
 * `registry[target.provider]` for the base URL, found nothing, and returned
 * "Unknown provider" — so a request for `vllm/needle-2` hung until exhaustion
 * even though the connection carried a perfectly good `baseUrl` in
 * `provider_specific_data`.
 *
 * The fix: TargetIterator now surfaces `provider_specific_data.baseUrl` on the
 * TargetRow, and tryTarget() prefers it over the registry entry. A local
 * provider with a connection-specific baseUrl routes even when no registry
 * entry exists.
 *
 * Runs against a throwaway DATA_DIR — never the operator's real storage.sqlite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-local-baseurl-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { TargetIterator } = await import("../../src/lib/db/targetIterator.ts");

const VLLM_BASE_URL = "http://localhost:8000/v1";
const VLLM_CONNECTION_ID = "vllm-local-conn-1";
const VLLM_MODEL = "needle-2";

interface SeedConn {
  id: string;
  provider: string;
  model: string;
  psd: string | null;
}

const SEED_CONNS: SeedConn[] = [
  // The main case: vllm with a connection-specific baseUrl.
  { id: VLLM_CONNECTION_ID, provider: "vllm", model: VLLM_MODEL, psd: JSON.stringify({ baseUrl: VLLM_BASE_URL }) },
  // No baseUrl in provider_specific_data.
  { id: "ollama-no-baseurl", provider: "ollama-local", model: "llama3.2", psd: JSON.stringify({}) },
  // NULL provider_specific_data.
  { id: "lmstudio-null-psd", provider: "lm-studio", model: "qwen2.5", psd: null },
];

function seedConnections() {
  const db = core.getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO provider_connections
       (id, provider, auth_type, api_key, default_model, priority, is_active,
        backoff_level, provider_specific_data, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, 1, 1, 0, ?, ?, ?)`
  );
  for (const s of SEED_CONNS) {
    insert.run(s.id, s.provider, s.model, s.psd, now, now);
  }

  // Seed synced models per provider so the iterator can discover them.
  const insertModels = db.prepare(
    `INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)`
  );
  for (const s of SEED_CONNS) {
    insertModels.run(
      "syncedAvailableModels",
      s.provider,
      JSON.stringify([{ id: s.model, name: s.model, source: "imported" }])
    );
  }
}

test.before(() => {
  core.resetDbInstance();
  core.getDbInstance(); // runs migrations, creates the schema
  seedConnections();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("TargetIterator surfaces provider_specific_data.baseUrl for a local provider not in the routing REGISTRY", () => {
  const iterator = new TargetIterator({
    specificProvider: "vllm",
    specificModel: VLLM_MODEL,
  });
  const target = iterator.nextTarget();

  assert.ok(target, "expected a target for vllm/needle-2");
  assert.equal(target.provider, "vllm");
  assert.equal(target.modelId, VLLM_MODEL);
  assert.equal(target.modelStr, "vllm/needle-2");
  assert.equal(target.connectionId, VLLM_CONNECTION_ID);
  // The fix: baseUrl is carried from provider_specific_data, not lost.
  assert.equal(
    target.baseUrl,
    VLLM_BASE_URL,
    "baseUrl must be extracted from provider_specific_data so the thin gateway can route a local provider with no registry entry"
  );
});

test("TargetIterator returns baseUrl null when provider_specific_data has no baseUrl", () => {
  const iterator = new TargetIterator({
    specificProvider: "ollama-local",
    specificModel: "llama3.2",
  });
  const target = iterator.nextTarget();

  assert.ok(target, "expected a target for ollama-local/llama3.2");
  assert.equal(target.provider, "ollama-local");
  assert.equal(target.baseUrl, null, "baseUrl must be null when provider_specific_data has no baseUrl");
});

test("TargetIterator returns baseUrl null when provider_specific_data is NULL", () => {
  const iterator = new TargetIterator({
    specificProvider: "lm-studio",
    specificModel: "qwen2.5",
  });
  const target = iterator.nextTarget();

  assert.ok(target, "expected a target for lm-studio/qwen2.5");
  assert.equal(target.provider, "lm-studio");
  assert.equal(target.baseUrl, null, "baseUrl must be null when provider_specific_data is NULL");
});
