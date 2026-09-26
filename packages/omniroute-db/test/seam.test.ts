/**
 * The seam, checked against a real second implementation.
 *
 * These cases exist because `DbAdapter` is erased at runtime: nothing but
 * `DB_ADAPTER_METHODS` and the audit built on it stands between a half-written
 * adapter and a gateway that boots happily and fails on the first request that
 * happens to need the method nobody wrote. So the first case is the one that
 * catches the drift that costs the most — the list and the interface falling
 * out of step — and it catches it by running a real adapter through the audit
 * rather than by restating the list.
 */
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import DbSeamService, { DB_ADAPTER_METHODS, TARGET_CURSOR_METHODS } from '../src/index.ts'
import MemoryAdapterService from '../../omniroute-db-memory/src/index.ts'

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms))

async function seam(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(DbSeamService, config as any)
  await settle()
  return { ctx, dbSeam: ctx.get('dbSeam') as DbSeamService }
}

async function memory(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(MemoryAdapterService, config as any)
  await settle()
  return ctx.get('db') as unknown as MemoryAdapterService
}

test('a real second adapter satisfies the whole contract', async () => {
  const { dbSeam } = await seam()
  const adapter = await memory()
  assert.deepEqual(dbSeam.missing(adapter), [])
  assert.deepEqual(dbSeam.audit(adapter), [])
})

test('so does the cursor that adapter hands back', async () => {
  const { dbSeam } = await seam()
  const adapter = await memory()
  assert.deepEqual(dbSeam.missingCursor(adapter.createTargetCursor({})), [])
})

test('the contract names every method, and the audit names the ones missing', async () => {
  const { dbSeam } = await seam()
  const half: Record<string, unknown> = {}
  for (const method of DB_ADAPTER_METHODS.slice(0, 3)) half[method] = () => {}
  const gaps = dbSeam.audit(half)
  assert.equal(gaps?.length, DB_ADAPTER_METHODS.length - 3)
  // The point of naming them: an operator can fix the adapter from the log line
  // alone. A bare count could not tell them which method to write.
  assert.ok(gaps?.includes('kvGet'))
  assert.ok(!gaps?.includes('kind'))
})

test('the five members the router leaked through are now in the contract', async () => {
  // Named literally, because the whole of Scope 8 is that these five questions
  // stopped being asked of SQLite by name. If one is ever dropped from the
  // interface, the router silently regains a direct dependency.
  for (const method of ['kind', 'createTargetCursor', 'rateLimitedProviders', 'recordTokenRefusal', 'recordModelIncapable']) {
    assert.ok(DB_ADAPTER_METHODS.includes(method as never), `${method} left the contract`)
  }
})

test('nothing at all is a null audit, not an empty one', async () => {
  const { dbSeam } = await seam()
  // "No adapter yet" and "an adapter with no methods" must not read the same:
  // the first is a load-order fact, the second is a broken row.
  assert.equal(dbSeam.audit(undefined), null)
  assert.deepEqual(dbSeam.missing(undefined), [...DB_ADAPTER_METHODS])
})

test('strict refuses the boot instead of warning', async () => {
  const { dbSeam } = await seam({ strict: true })
  assert.throws(() => dbSeam.audit({ kind: () => 'broken' }), /missing 14 of 15 seam methods/)
})

test('a cursor missing triedProviders is caught, though every method is present', async () => {
  const { dbSeam } = await seam()
  const noGetter: Record<string, unknown> = {}
  for (const method of TARGET_CURSOR_METHODS) noGetter[method] = () => {}
  // `triedProviders` is a getter, not a method, so a `typeof === 'function'`
  // sweep would pass this object — and the router would then call
  // `new Set(undefined)` on the exhaustion path only, hours later.
  assert.deepEqual(dbSeam.missingCursor(noGetter), ['triedProviders'])
})
