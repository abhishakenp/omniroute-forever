/**
 * The second adapter, on its own terms.
 *
 * The interesting cases are not "does the Map work". They are the invariants
 * the SQLite adapter enforces in SQL and that a new adapter is therefore most
 * likely to lose: a reserved credential must never be spent by general traffic,
 * a failed credential must not be offered twice in the same request, and a
 * token refusal must converge downward rather than being overwritten by the
 * last thing seen. Each of those is a rule about routing, not about storage,
 * which is exactly why it belongs to every adapter and not to one.
 */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import MemoryAdapterService from '../src/index.ts'

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms))

async function mount(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryAdapterService, config as any)
  await settle()
  return ctx.get('db') as unknown as MemoryAdapterService
}

test('it says what it is, and it is not sqlite', async () => {
  assert.equal((await mount()).kind(), 'memory')
})

test('a cursor walks every row once and then says it is done', async () => {
  const db = await mount({ targets: ['memory/a', 'memory/b'] })
  const cursor = db.createTargetCursor({})
  assert.equal(cursor.nextTarget()?.modelStr, 'memory/a')
  assert.equal(cursor.nextTarget()?.modelStr, 'memory/b')
  assert.equal(cursor.nextTarget(), null)
})

test('two cursors do not share a tried-set', async () => {
  // Request-scoped, not adapter-scoped. Sharing it would mean the second
  // request of a process saw an empty pool.
  const db = await mount({ targets: ['memory/a'] })
  assert.equal(db.createTargetCursor({}).nextTarget()?.modelStr, 'memory/a')
  assert.equal(db.createTargetCursor({}).nextTarget()?.modelStr, 'memory/a')
})

test('a reserved row is invisible to general traffic', async () => {
  const db = await mount({ targets: ['memory/held'], reservedFor: 'iris/always' })
  assert.equal(db.createTargetCursor({}).nextTarget(), null)
  assert.equal(db.createTargetCursor({ reservedFor: 'iris/always' }).nextTarget()?.modelStr, 'memory/held')
  // And not to a *different* consumer either — the failure mode that matters is
  // a tag leaking sideways, not a tag failing to match itself.
  assert.equal(db.createTargetCursor({ reservedFor: 'someone/else' }).nextTarget(), null)
})

test('a failed credential is not offered again while it is cooling', async () => {
  const db = await mount({ targets: ['memory/a', 'memory/b'] })
  let clock = 1_000
  db.now = () => clock
  const first = db.createTargetCursor({})
  const target = first.nextTarget()!
  first.markFailed(target.connectionId, 429, 5_000)

  assert.equal(db.createTargetCursor({}).nextTarget()?.modelStr, 'memory/b')
  clock += 5_001
  assert.equal(db.createTargetCursor({}).nextTarget()?.modelStr, 'memory/a')
})

test('a cooling credential is what rateLimitedProviders reports', async () => {
  // The exhaustion path asks this question to decide who to ask the provisioner
  // for. A provider whose only key is cooling was never *tried*, so it is
  // invisible to triedProviders — which is the entire reason this method exists.
  const db = await mount({ targets: ['alpha/one', 'beta/one'] })
  let clock = 1_000
  db.now = () => clock
  assert.deepEqual(await db.rateLimitedProviders(), [])
  await db.markFailed('mem-1', 429, 60_000)
  assert.deepEqual(await db.rateLimitedProviders(), ['alpha'])
})

test('triedProviders names the providers handed out, not the rows', async () => {
  const db = await mount({ targets: ['alpha/one', 'alpha/two', 'beta/one'] })
  const cursor = db.createTargetCursor({})
  cursor.nextTarget()
  cursor.nextTarget()
  assert.deepEqual([...cursor.triedProviders], ['alpha'])
  cursor.nextTarget()
  assert.deepEqual([...cursor.triedProviders].sort(), ['alpha', 'beta'])
})

test('a token refusal converges downward and never back up', async () => {
  const db = await mount()
  await db.recordTokenRefusal('memory/fake-alpha', 8000)
  await db.recordTokenRefusal('memory/fake-alpha', 4000)
  await db.recordTokenRefusal('memory/fake-alpha', 9000)
  assert.equal(db.learned.refusals.get('memory/fake-alpha'), 4000)
})

test('a model proven unable to chat is retired, not merely noted', async () => {
  const db = await mount({ targets: ['memory/not-a-chat-model'] })
  await db.recordModelIncapable('memory/not-a-chat-model', 'invalid request: model cannot chat')
  assert.equal(db.learned.incapable.get('memory/not-a-chat-model'), 'invalid request: model cannot chat')
  assert.equal(db.createTargetCursor({}).nextTarget(), null)
})

test('create, update and delete move what the cursor sees', async () => {
  const db = await mount({ targets: [] })
  assert.equal(db.createTargetCursor({}).nextTarget(), null)
  const id = await db.createProviderConnection({ provider: 'made-up', defaultModel: 'v1', apiKey: 'x' })
  assert.equal(db.createTargetCursor({}).nextTarget()?.modelStr, 'made-up/v1')
  await db.updateProviderConnection(id, { isActive: false })
  assert.equal(db.createTargetCursor({}).nextTarget(), null)
  assert.equal(await db.deleteProviderConnection(id), true)
  assert.equal(await db.deleteProviderConnection(id), false)
})

test('kv round-trips and a missing key is null, not undefined', async () => {
  const db = await mount()
  assert.equal(await db.kvGet('nope'), null)
  await db.kvSet('k', 'v')
  assert.equal(await db.kvGet('k'), 'v')
})

test('a watcher hears writes, and stops hearing them once released', async () => {
  const db = await mount({ targets: [] })
  let heard = 0
  const stop = db.watchProviderConnections(() => { heard += 1 })
  await db.createProviderConnection({ provider: 'x' })
  assert.equal(heard, 1)
  stop()
  await db.createProviderConnection({ provider: 'y' })
  assert.equal(heard, 1)
})

test('a watcher that throws does not silence the next one', async () => {
  const db = await mount({ targets: [] })
  let second = 0
  db.watchProviderConnections(() => { throw new Error('subscriber fault') })
  db.watchProviderConnections(() => { second += 1 })
  await db.createProviderConnection({ provider: 'x' })
  assert.equal(second, 1)
})

test('queryProviderConnections hides reserved rows from general traffic', async () => {
  const db = await mount({ targets: ['memory/held'], reservedFor: 'iris/always' })
  assert.equal((await db.queryProviderConnections()).length, 0)
  assert.equal((await db.queryProviderConnections({ reservedFor: 'iris/always' })).length, 1)
})
