# OmniRoute Code Plan — `~/proj/omniroute-forever`

Architecture: `~/proj/sensei/iris-mama/specs/arch-plan/2026-09-07T18-47-iris-rlm-omniroute-provisioner-ecosystem-rewrite.md`
Cross-project index: `~/proj/sensei/iris-mama/specs/arch-plan/projects/README.md`

## Scopes Owned

| Scope | What | Cross-project deps | Status |
|---|---|---|---|
| 3 | reserved alias (`reserved_for` column + targetIterator + thinGateway) | none | done |
| 7 | Cordis host rewrite (separate branch) | none (isolated branch) | done |
| 8 | DB seam + SQLite adapter | needs Scope 7 | done |
| 9 | Convex adapter + login + migration | needs Scope 8 | done (local deployment verified; production Convex unverified) |
| 10 (omni side) | provisioner SDK plugin | needs Scope 7 | done |

## Scope 3: Reserved Alias

### Files
| File | Line(s) | Change |
|---|---|---|
| NEW `src/lib/db/migrations/143_reserved_for.sql` | — | Add `reserved_for` column |
| `src/lib/db/targetIterator.ts` | 375-396 | Add `reservedFor` to constructor opts |
| `src/lib/db/targetIterator.ts` | 428-445 | Add `reserved_for` filter to candidate query |
| `src/server/headless/thinGateway.ts` | 165-181 | Detect `iris/` prefix as reserved alias BEFORE direct-provider parsing |
| `src/server/headless/thinGateway.ts` | 189-195 | Pass `reservedFor` to TargetIterator |
| `src/lib/db/providers.ts` | 380, 825 | Accept `reserved_for` in create/update |

### Migration file `src/lib/db/migrations/143_reserved_for.sql`
```sql
-- 143_reserved_for.sql
-- Add reserved_for column to provider_connections.
-- Allows keys to be reserved for a specific consumer (e.g. "iris/always").
-- NULL means general pool (available to all consumers).

ALTER TABLE provider_connections ADD COLUMN reserved_for TEXT DEFAULT NULL;
```
Runs automatically at startup via `migrationRunner.ts`. No changes to `core.ts` SCHEMA_SQL.

### targetIterator.ts (line 375-396)
Add `reservedFor?: string` to constructor opts. In `nextTarget()` query (line 428-445):
```sql
AND (reserved_for IS NULL OR reserved_for = ?)
```
When `reservedFor` is set, order by `reserved_for = ? DESC` so reserved keys tried first, then general pool.

### thinGateway.ts (line 165-181) — CRITICAL
Current code at line 175-181 treats anything not starting with `auto/` as direct provider/model. `iris/always` would be parsed as `specificProvider: 'iris'`, `specificModel: 'always'` — wrong.

```ts
// Add after line 168, before the !isAuto block:
const reservedAlias = req.model.startsWith('iris/') ? req.model : undefined
const isAutoOrReserved = isAuto || !!reservedAlias

// Change line 175: if (!isAuto) → if (!isAutoOrReserved)
if (!isAutoOrReserved) {
  // existing direct provider/model parsing
}

// In TargetIterator construction (line 189-195):
const iterator = new TargetIterator({
  freeProvidersOnly: isFreeOnly,
  specificProvider,
  specificModel,
  promptTokens,
  outputTokens,
  reservedFor: reservedAlias,  // NEW
})
```

### Fallback semantics
- `iris/always` requests: try `reserved_for = 'iris/always'` first, fall back to `reserved_for IS NULL`
- General requests (`auto/best`, `auto/best-free`): only `reserved_for IS NULL`
- No 503 while general-pool keys available

### Bloom Filter — Explicit Decision: NOT NEEDED
Research verified from `targetIterator.ts` source:
- OmniRoute already uses request-scoped `Set<string>` for tried connection IDs
- Within a single request, iterator skips tried targets via in-memory sets
- Bloom filter adds probabilistic false-positive risk to a zero-false-positive path
- ~711 connections across 11 providers — well within Set's efficient range
- Cross-request dedup already handled by DB state (`rate_limited_until`, `backoff_level`, `test_status`)

### Test
```bash
cd ~/proj/omniroute-forever
bun test src/lib/db/targetIterator.test.ts
# Integration:
curl -X POST http://localhost:20128/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"iris/always","messages":[{"role":"user","content":"hello"}]}'
```

### Rollback
Column is nullable with default NULL — existing rows unaffected. Revert thinGateway change.

### Hot-reload
OmniRoute is not hot-reloaded — restart required. Iris unaffected (config change only).

---

## Scope 7: Cordis Host Rewrite (separate branch)

### Branch procedure
```bash
cd ~/proj/omniroute-forever
git checkout main
git pull
git checkout -b rewrite/cordis-host
```

**DO NOT MERGE to main until user explicitly directs.**

### Files to create
| File | Purpose |
|---|---|
| `omniroute.mjs` | Cordis host entry (same pattern as `iris.mjs`) |
| `packages/omniroute-gateway/src/index.ts` | Router/gateway plugin (from `thinGateway.ts` + `server-elysia.ts`) |
| `packages/omniroute-router/src/index.ts` | Model alias routing |
| `packages/omniroute-db/src/index.ts` | DB seam service definition (DbAdapter interface) |
| `packages/omniroute-db-sqlite/src/index.ts` | SQLite adapter (from `core.ts` + `targetIterator.ts` + `providers.ts`) |
| `packages/omniroute-executor/src/index.ts` | Default executor plugin (from `default.ts` + `base.ts`) |
| `packages/omniroute-registry/src/index.ts` | Provider registry plugin (from `open-sse/config/providers/`) |
| `packages/omniroute-keystore/src/index.ts` | Key store/auth plugin (from `encryption.ts`) |
| `packages/omniroute-provisioner/src/index.ts` | Provisioner hook plugin (from `provisionerHook.ts`) |
| `packages/omniroute-logger/src/index.ts` | Logger/error plugin (from `sse/utils/logger.ts` + `failureDomain.ts`) |
| `cordis.yml` | Composition |

### PRESERVE — live path files (rewrite into Cordis plugins)

These are the ONLY files on the live `/v1/chat/completions` path. Everything else is dead.

| Source file | Lines | Destination plugin |
|---|---|---|
| `src/server/headless/server-elysia.ts` | 452 | `omniroute-gateway` (entry + route loading) |
| `src/server/headless/thinGateway.ts` | 622 | `omniroute-gateway` (request handler) |
| `src/server/headless/failureDomain.ts` | 466 | `omniroute-logger` (error taxonomy) |
| `src/lib/db/core.ts` | 1,635 | `omniroute-db-sqlite` (SQLite singleton + schema) |
| `src/lib/db/encryption.ts` | 335 | `omniroute-keystore` (AES-256-GCM) |
| `src/lib/db/targetIterator.ts` | 809 | `omniroute-db-sqlite` (target selection) |
| `src/lib/db/providers.ts` | 1,045 | `omniroute-db-sqlite` (provider CRUD) |
| `src/lib/db/providers/deletion.ts` | 181 | `omniroute-db-sqlite` (delete/reorder) |
| `src/lib/db/providers/columns.ts` | — | `omniroute-db-sqlite` (column normalizers) |
| `src/lib/db/providers/lazyConnectionView.ts` | — | `omniroute-db-sqlite` (lazy row proxy) |
| `src/lib/db/keylessHealth.ts` | 250 | `omniroute-db-sqlite` (no-auth cooldowns) |
| `src/lib/db/modelFitness.ts` | 197 | `omniroute-db-sqlite` (token/context fit) |
| `src/lib/db/seedLocalCliConnections.ts` | 148 | `omniroute-db-sqlite` (boot-time seeding) |
| `src/lib/db/caseMapping.ts` | — | `omniroute-db-sqlite` (snake/camel) |
| `src/lib/db/schemaColumns.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/readCache.ts` | — | `omniroute-db-sqlite` (cache invalidation) |
| `src/lib/db/migrationRunner.ts` + constants + extraDirs | — | `omniroute-db-sqlite` (110 migrations) |
| `src/lib/db/migrations/*.sql` | 110 files | `omniroute-db-sqlite` (preserve ALL migration files) |
| `src/lib/db/healthCheck.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/stateReset.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/optimizationSettings.ts` | — | `omniroute-db-sqlite` (PRAGMA tuning) |
| `src/lib/db/probeUtils.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/backup.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/settings.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/combos.ts` | — | `omniroute-db-sqlite` (cleanupComboConnectionRefs only) |
| `src/lib/db/reasoningRoutingRules.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/webSessionDedup.ts` | — | `omniroute-db-sqlite` |
| `src/lib/db/adapters/driverFactory.ts` + adapter files | — | `omniroute-db-sqlite` (SQLite driver) |
| `src/lib/db/adapters/types.ts` | — | `omniroute-db-sqlite` |
| `src/sse/services/provisionerHook.ts` | 612 | `omniroute-provisioner` |
| `src/sse/utils/logger.ts` | — | `omniroute-logger` |
| `open-sse/executors/index.ts` | 162 | `omniroute-executor` (factory) |
| `open-sse/executors/default.ts` | 1,118 | `omniroute-executor` (standard) |
| `open-sse/executors/base.ts` | 1,680 | `omniroute-executor` (base class) |
| `open-sse/executors/base/headers.ts` | — | `omniroute-executor` |
| `open-sse/executors/default/urlNormalizers.ts` | — | `omniroute-executor` |
| `open-sse/executors/default/poolConfig.ts` | — | `omniroute-executor` |
| `open-sse/executors/default/nvidiaConcurrencyGate.ts` | — | `omniroute-executor` |
| `open-sse/executors/default/zaiFormatOverride.ts` | — | `omniroute-executor` |
| `open-sse/executors/auggie.ts` | — | `omniroute-executor` (local CLI) |
| `open-sse/executors/duckduckgo-web.ts` + challenge.ts | — | `omniroute-executor` (no-auth) |
| `open-sse/executors/felo-web.ts` | — | `omniroute-executor` (no-auth) |
| `open-sse/executors/pollinations.ts` | — | `omniroute-executor` |
| `open-sse/executors/opencode.ts` | — | `omniroute-executor` |
| `open-sse/executors/puter.ts` | — | `omniroute-executor` |
| `open-sse/executors/huggingchat.ts` + jsonlStream.ts | — | `omniroute-executor` |
| `open-sse/executors/lmarena.ts` + subfiles | — | `omniroute-executor` |
| `open-sse/services/autoCombo/providerRegistryAccessor.ts` | — | `omniroute-registry` |
| `open-sse/config/providerRegistry.ts` | — | `omniroute-registry` |
| `open-sse/config/providers/index.ts` | — | `omniroute-registry` |
| `open-sse/config/providers/shared.ts` | — | `omniroute-registry` (types) |
| `open-sse/config/providers/registry/*/index.ts` | — | `omniroute-registry` (all provider entries) |
| `open-sse/services/providerRequestDefaults.ts` | — | `omniroute-registry` |
| `open-sse/utils/error.ts` | — | `omniroute-logger` |
| `open-sse/config/constants.ts` | — | `omniroute-registry` (PROVIDERS, OAUTH_ENDPOINTS) |
| `open-sse/config/providerModels.ts` | — | `omniroute-registry` |
| `open-sse/config/providerHeaderProfiles.ts` | — | `omniroute-registry` |
| `open-sse/config/anthropicHeaders.ts` | — | `omniroute-registry` |
| `open-sse/config/codexClient.ts` | — | `omniroute-registry` |
| `open-sse/config/glmProvider.ts` | — | `omniroute-registry` |
| `open-sse/config/maritalk.ts` | — | `omniroute-registry` |
| `open-sse/config/antigravity*.ts`, `agyModels.ts` | — | `omniroute-registry` |
| `open-sse/utils/publicCreds.ts` | — | `omniroute-registry` |
| `open-sse/config/providers/alternateFormats.ts` | — | `omniroute-executor` |
| `src/lib/dataPaths.ts` | — | `omniroute-gateway` |
| `src/lib/stdoutLogRotation.ts` | — | `omniroute-logger` |

**Total live path: 9,436 lines across 16 core files + 137 migration files (3,322 lines SQL). Measured via `wc -l`.**

### DELETE — dead code (not on live path)

| Directory | Lines | What | Verdict |
|---|---|---|---|
| `@omniroute/opencode-plugin/` | — | OpenCode editor plugin | DELETE |
| `@omniroute/opencode-provider/` | — | OpenCode provider package | DELETE |
| `bin/` | 36,006 | CLI entry + ~75 commands | DELETE |
| `config/` | 5,277 | Lint/ratchet/quality baselines | DELETE |
| `docs/` | 56,899 | Markdown docs, diagrams | DELETE |
| `public/` | — | Static icons, OpenAPI YAML, PWA assets | DELETE |
| `scripts/` | 46,730 | Build, dev, release, i18n scripts | DELETE |
| `tests/` | 706,919 | Unit, integration, e2e, fixtures | DELETE |
| `src/app/` | 21,232 | Next.js App Router (all route.ts files) | DELETE |
| `src/domain/` | — | Domain logic, combo/policy | DELETE |
| `src/models/` | — | Model index barrel | DELETE |
| `src/types/` | — | Shared TS types | DELETE |
| `src/server/auth/` | — | loginGuard | DELETE |
| `src/server/authz/` | — | accessTokenAuth, headers | DELETE |
| `src/server/cors/` | — | origins | DELETE |
| `src/server/origin/` | — | publicOrigin | DELETE |
| `src/server/ws/` | — | liveServer, allowList, types | DELETE |
| `src/server/headless/server.ts` | — | Broken (imports missing router.ts) | DELETE |
| `src/server/headless/__tests__/` | — | Tests | DELETE |
| `src/sse/services/` (except provisionerHook.ts) | — | auth, cooldown, tokenRefresh, etc. (14 files) | DELETE |
| `src/sse/utils/backpressure.ts` | — | Backpressure utils | DELETE |
| `src/lib/` (non-db, except dataPaths.ts + stdoutLogRotation.ts) | — | CLI helpers, agent bridges, cloud sync, copilot | DELETE |
| `src/lib/db/` (~70 dead modules) | — | apiKeys, batches, callLogStats, ccDiscovery, cliToolState, combos (most), commandCodeAuth, compression, creditBalance, discovery, evals, featureFlags, files, freeProxies, gamification, memoryVec, middleware, notion, obsidian, omp, oneproxy, playgroundPresets, pluginMetrics, plugins, prompts, providerLimits, providerPlans, providerStats, quota, proxy, etc. | DELETE |
| `open-sse/services/` (except providerRegistryAccessor.ts + providerRequestDefaults.ts) | ~134 files | combo engine, routing, quota, fallback | DELETE |
| `open-sse/handlers/` | — | Request handlers | DELETE |
| `open-sse/translator/` | — | Translators | DELETE |
| Audio/image/embedding/moderation/music/ocr/tts registries + executors | — | Non-chat executors | DELETE |
| Dead per-provider executors | — | adobe-firefly, awsPollyTts, azure-ai, claudeIdentity, codex, cursor, gemini-business, github, grok-cli, vertex, windsurf, etc. | DELETE |

**Total deletion: ~151,483 .ts lines (160,919 total - 9,436 live path). Measured via `find + wc -l`. Plus 137 migration files (3,322 lines SQL) preserved.**

### Migration preservation
- **Preserve ALL 137 `src/lib/db/migrations/*.sql` files** — these are the schema history. The SQLite adapter must run them at startup. (137 measured via `ls *.sql | wc -l`)
- `core.ts` `SCHEMA_SQL` defines 17 base tables; migrations add the rest.
- Migration `143_reserved_for.sql` (from Scope 3) should be created on `main` first, then cherry-picked into the rewrite branch.

### Test
```bash
node omniroute.mjs
curl -X POST http://localhost:20128/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto/best-free","messages":[{"role":"user","content":"hello"}]}'
# Verify same behavior as server-elysia.ts
```

### Rollback
Just don't merge the branch. Live `main` is untouched.

---

## Scope 8: DB Seam + SQLite Adapter

### DbAdapter interface
```ts
interface DbAdapter {
  queryProviderConnections(opts?: { reservedFor?: string; provider?: string; freeOnly?: boolean }): Promise<TargetRow[]>
  markFailed(connectionId: string, status: number, cooldownMs: number): Promise<void>
  markSucceeded(connectionId: string): Promise<void>
  createProviderConnection(data: ProviderConnectionInput): Promise<string>
  updateProviderConnection(id: string, data: Partial<ProviderConnectionInput>): Promise<void>
  deleteProviderConnection(id: string): Promise<boolean>
  kvGet(key: string): Promise<string | null>
  kvSet(key: string, value: string): Promise<void>
  watchProviderConnections(callback: () => void): () => void
  dispose(): Promise<void>
}
```

### Files
| File | Purpose |
|---|---|
| `packages/omniroute-db/src/index.ts` | `DbAdapter` interface + `ctx.db` service |
| `packages/omniroute-db-sqlite/src/index.ts` | SQLite implementation (from existing `core.ts` + `targetIterator.ts` + `providers.ts`) |

### Hot-swap
`ctx.db` service. On adapter swap: in-flight calls complete on old adapter, new calls hit new adapter. `internal/service` re-attach for all consumers.

### Cross-project dependency
Needs Scope 7 (must be on Cordis branch).

---

## Scope 9: Convex Adapter + Login + Migration

### Files
| File | Purpose |
|---|---|
| `packages/omniroute-db-convex/src/index.ts` | Convex adapter implementing DbAdapter |
| `packages/omniroute-db-convex-login/src/index.ts` | One-shot login/setup plugin |
| `packages/omniroute-db-convex-migrate/src/index.ts` | SQLite → Convex migration |

### Convex auth plugin
- `bunx convex` for login/project/deployment setup
- Deployment token stored securely — NOT in plaintext `convex.env`
- Use OS keychain or encrypted secret store

### Migration
- Read all `provider_connections` from SQLite
- Batch import to Convex (not per-row HTTP)
- Verify row count matches
- Hot-swap sqlite→convex via `ctx.db`

### Cross-project dependency
Needs Scope 8 (DbAdapter interface must exist).

### Implementation status (reconciled)

| Item | Status | Notes |
|---|---|---|
| Convex schema | done | `convex/schema.ts` — `providerConnections` + `kv` tables |
| Convex backend functions | done | `convex/providerConnections.ts`, `convex/kv.ts` |
| Convex adapter | done | `packages/omniroute-db-convex/src/index.ts` — implements `DbAdapter`. Contract tests: 4 pass. |
| Convex login plugin | done | `packages/omniroute-convex-login/src/index.ts` |
| SQLite → Convex migration | done | `packages/omniroute-convex-migrate/src/index.ts` |
| Local deployment | done | `bunx convex dev --once` configured `anonymous:anonymous-omniroute-forever` at `http://127.0.0.1:3210` |
| Hot-swap documentation | done | `cordis.yml` documents two-step swap: remove SQLite row, add Convex rows |
| Production Convex | unverified | Not run with real Convex credentials. Local deployment only. |

---

## Scope 10 (omni side): Provisioner SDK Plugin

### Phase 1: Lightweight SDK plugin
```ts
// packages/omniroute-provisioner-sdk/src/index.ts
export class ProvisionerSdkService extends Service {
  static provide = 'provisioner' as const

  async trigger(provider: string): Promise<{ ok: boolean; status: string }> {
    const response = await fetch(`${this.config.endpoint}/provision/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ async: true }),
      signal: AbortSignal.timeout(10_000),
    })
    return { ok: response.ok, status: response.status.toString() }
  }
}
```
Config: `endpoint: Schema.string().default('http://localhost:20129')`

No changes to account-provisioner itself in Phase 1.

### Cross-project dependency
Needs Scope 7 (must be on Cordis branch). Calls provisioner's existing HTTP API — no provisioner changes.
