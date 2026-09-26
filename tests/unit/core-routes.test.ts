import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { apiDirFor, discoverRoutes, matchRoute } from "../../src/server/headless/coreRoutes.ts";

// Both hosts (server-elysia and the Cordis gateway row) serve this table. The
// Cordis gateway once served only /health, /v1/models and chat, which would
// have stopped the account provisioner: it adds, updates and removes
// connections through /api/providers.
const root = fileURLToPath(new URL("../../", import.meta.url));
const routes = discoverRoutes(apiDirFor(root));

describe("core routes", () => {
  it("serves the provisioner's connection routes", () => {
    assert.ok(matchRoute("/api/providers", routes), "/api/providers");
    const byId = matchRoute("/api/providers/abc-123", routes);
    assert.ok(byId, "/api/providers/:id");
    assert.equal(Object.values(byId!.params)[0], "abc-123");
  });

  it("serves the model and messages APIs clients call", () => {
    for (const p of ["/api/v1/models", "/api/v1/messages", "/api/v1/responses", "/api/v1/embeddings"]) {
      assert.ok(matchRoute(p, routes), p);
    }
  });

  it("leaves the dashboard out", () => {
    assert.equal(matchRoute("/api/settings/theme-probe-not-core", routes), null);
  });
});
