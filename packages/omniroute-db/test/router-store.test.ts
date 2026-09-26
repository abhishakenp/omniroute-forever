/**
 * The seam, from the router's side.
 *
 * `seam.test.ts` proves an adapter satisfies the contract. That is worth
 * nothing if the router never asks through it — which was the state of things
 * before Scope 8, when `ctx.db` existed, audited clean, and was consumed by
 * absolutely nobody. So these cases drive `handleThinGateway` itself with a
 * store that has no database behind it, and read the answer.
 *
 * DATA_DIR is pointed at the Scope 7 copy before anything is imported: the
 * import chain reaches `core.ts`, which resolves the SQLite path as it
 * evaluates. Nothing here opens that file — the whole point is that the memory
 * store answers instead — but a module that resolved to `~/.omniroute` would be
 * one accidental call away from the live 38 MB database.
 */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'

process.env.DATA_DIR ??= '/private/tmp/claude-501/-Users-abhi-proj-sensei-iris-mama/deef7f7c-8a9e-4e97-8715-b074b42ca6a4/scratchpad/omniroute-data'

const { getRouterStore, setRouterStore } = await import('../../../src/server/headless/thinGateway.ts')
const { default: MemoryAdapterService } = await import('../../omniroute-db-memory/src/index.ts')

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms))

async function memoryStore(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryAdapterService, config as any)
  await settle()
  const adapter = ctx.get('db') as any
  return {
    adapter,
    store: {
      createTargetCursor: (query: any) => adapter.createTargetCursor(query),
      rateLimitedProviders: () => adapter.rateLimitedProviders(),
      recordTokenRefusal: (m: string, t: number) => adapter.recordTokenRefusal(m, t),
      recordModelIncapable: (m: string, r: string) => adapter.recordModelIncapable(m, r),
    },
  }
}

test('there is always a store, even when nobody installed one', () => {
  // A router with no store cannot route, so the default is not null. That the
  // default is the SQLite one is what keeps `server-elysia.ts` — which installs
  // nothing — behaving exactly as it did.
  const store = getRouterStore()
  assert.equal(typeof store.createTargetCursor, 'function')
  assert.equal(typeof store.rateLimitedProviders, 'function')
})

test('installing one replaces it, and the undo puts back what was there', async () => {
  const before = getRouterStore()
  const { store } = await memoryStore()
  const undo = setRouterStore(store as any)
  assert.equal(getRouterStore(), store)
  undo()
  assert.equal(getRouterStore(), before)
})

test('an unload does not clobber a store installed after it', async () => {
  // The reload-ordering hazard: during a hot-swap both rows are briefly alive,
  // the successor installs, and then the predecessor unloads. A naive `clear()`
  // there would point the router back at SQLite while the memory row is the one
  // actually mounted — a silent wrong-store, which is the worst kind.
  const first = await memoryStore({ targets: ['first/one'] })
  const second = await memoryStore({ targets: ['second/one'] })
  const undoFirst = setRouterStore(first.store as any)
  setRouterStore(second.store as any)
  undoFirst()
  assert.equal(getRouterStore(), second.store)
})

test('a completion routed through the memory store names the memory store targets', async () => {
  const { store } = await memoryStore({ targets: ['memoryproof/alpha', 'memoryproof/beta'] })
  const undo = setRouterStore(store as any)
  try {
    const { handleThinGateway } = await import('../../../src/server/headless/thinGateway.ts')
    const response = await handleThinGateway({
      body: { model: 'auto/best-free', messages: [{ role: 'user', content: 'hello' }] },
      model: 'auto/best-free',
      stream: false,
    })
    const text = await response.text()
    // The request must fail — the memory store's credentials are fake and reach
    // no upstream. What it must NOT do is fail with a real provider's name:
    // that would mean the router asked SQLite regardless of what was installed.
    assert.ok(
      text.includes('memoryproof'),
      `the router did not use the installed store; it answered: ${text.slice(0, 400)}`,
    )
  } finally {
    undo()
  }
}, 90_000)
