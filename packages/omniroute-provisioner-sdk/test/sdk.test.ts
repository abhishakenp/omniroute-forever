/**
 * The provisioner seam, against a real HTTP server.
 *
 * The server is a real `node:http` listener on a real ephemeral port, so the
 * fetch, the JSON, the status codes and the timeouts are production code paths.
 * What is faked is only what the provisioner would have said — and the stub
 * says the *dangerous* thing on purpose: the blocking `POST /provision/:p`
 * response really does carry `apiKey` and `email`
 * (`account-provisioner/src/sdk/server.ts:532-540`), so the case that matters
 * most is the one where the stub answers with a credential and this row is
 * measured on whether any of it survives.
 *
 * The live provisioner on :20129 is never called here. It creates real accounts
 * against real external providers and spends real quota; a test suite that can
 * do that is a test suite nobody can run twice.
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { afterAll, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import ProvisionerSdkService, { scrub } from '../src/index.ts'

type Route = (req: { url: string; method: string; body: any }, respond: (status: number, payload: unknown) => void) => void

const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
})

async function serving(route: Route): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body: any = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        /* the test's problem, not the row's */
      }
      route({ url: req.url ?? '', method: req.method ?? 'GET', body }, (status, payload) => {
        if (res.writableEnded) return
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const settle = (ms = 20) => new Promise((done) => setTimeout(done, ms))

async function mount(config: Record<string, unknown>) {
  const ctx = new Context()
  const fiber = await ctx.plugin(ProvisionerSdkService, config as any)
  await settle()
  return { ctx, fiber, sdk: ctx.get('provisionerSdk') as ProvisionerSdkService }
}

/** The provisioner's real async-mode answer, field for field. */
const ASYNC_ACCEPTED = {
  triggered: true,
  jobId: 'dahl-1788829000000',
  provider: 'dahl',
  message: 'Provisioning started in background — listen to /stream for results',
  streamUrl: '/stream',
}

/** The provisioner's real BLOCKING answer. Carries a live credential. */
const BLOCKING_WITH_SECRET = {
  provider: 'dahl',
  success: true,
  email: 'auto-1788829000000@example.com',
  apiKey: 'sk-live-9f3a7c1e55b24d8fae0071cc',
  omnirouteId: 'conn-abc-123',
  verified: true,
  durationMs: 41230,
}

test('a trigger reaches the provisioner and comes back with the job it queued', async () => {
  let seen: any
  const endpoint = await serving((req, respond) => {
    seen = req
    respond(200, ASYNC_ACCEPTED)
  })
  const { sdk } = await mount({ endpoint })

  const result = await sdk.trigger('dahl')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.url, '/provision/dahl')
  assert.equal(seen.body.async, true)
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.triggered, true)
  assert.equal(result.jobId, 'dahl-1788829000000')
  assert.equal(result.streamUrl, '/stream')
})

test('NOT ONE FIELD of a credential-bearing body survives the projection', async () => {
  // The single most important case in this file. The provisioner's blocking
  // response is a live API key and the address of the account it belongs to.
  const endpoint = await serving((_req, respond) => respond(200, BLOCKING_WITH_SECRET))
  const { sdk } = await mount({ endpoint, async: false })

  const result = await sdk.trigger('dahl')
  const serialised = JSON.stringify(result)
  assert.ok(!serialised.includes('sk-live'), `a key reached the caller: ${serialised}`)
  assert.ok(!serialised.includes('@example.com'), `an account address reached the caller: ${serialised}`)
  assert.ok(!serialised.includes('conn-abc-123'), `an omniroute id reached the caller: ${serialised}`)
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'provider', 'status', 'triggered'])
})

test('a field the provisioner has not invented yet is dropped, not passed', async () => {
  // The allow-list, stated as a test. A deny-list would pass this and would
  // have published whatever `refreshToken` turned out to be.
  const endpoint = await serving((_req, respond) =>
    respond(200, { ...ASYNC_ACCEPTED, refreshToken: 'rt-should-never-appear', sessionCookie: 'c-should-never-appear' }),
  )
  const { sdk } = await mount({ endpoint })
  const serialised = JSON.stringify(await sdk.trigger('dahl'))
  assert.ok(!serialised.includes('should-never-appear'), serialised)
})

test('a refusal says which refusal it is, without the body that carried it', async () => {
  const endpoint = await serving((_req, respond) =>
    respond(200, { skipped: true, reason: 'cooldown', provider: 'dahl', detail: 'cooldown active' }),
  )
  const { sdk } = await mount({ endpoint })
  const result = await sdk.trigger('dahl')
  assert.equal(result.ok, false)
  assert.equal(result.triggered, false)
  assert.equal(result.skippedReason, 'cooldown')
})

test('an unknown provider is a 404 with the reason, not a thrown error', async () => {
  const endpoint = await serving((_req, respond) => respond(404, { error: 'Unknown provider: nope' }))
  const { sdk } = await mount({ endpoint })
  const result = await sdk.trigger('nope')
  assert.equal(result.ok, false)
  assert.equal(result.status, 404)
  assert.match(result.error ?? '', /Unknown provider/)
})

test('a 500 whose body quotes a key does not put that key in the error', async () => {
  const endpoint = await serving((_req, respond) =>
    respond(500, `TypeError: signup failed for apiKey=sk-live-77aa11bb22cc33dd (auto-99@example.com)`),
  )
  const { sdk } = await mount({ endpoint })
  const result = await sdk.trigger('dahl')
  assert.equal(result.ok, false)
  assert.ok(!(result.error ?? '').includes('sk-live'), result.error)
  assert.ok(!(result.error ?? '').includes('@example.com'), result.error)
})

test('a provider name that is really a path is refused before the socket opens', async () => {
  let reached = false
  const endpoint = await serving((_req, respond) => {
    reached = true
    respond(200, ASYNC_ACCEPTED)
  })
  const { sdk } = await mount({ endpoint })
  const result = await sdk.trigger('../accounts/dahl/provision')
  assert.equal(result.ok, false)
  assert.equal(reached, false, 'a path traversal reached the provisioner')
})

test('status is counts and names — the shape the live provisioner actually returns', async () => {
  const endpoint = await serving((_req, respond) =>
    respond(200, {
      accounts: { total: 212, active: 185, byProvider: { dahl: 108, openrouter: 54 } },
      omniroute: { running: true, connections: 721 },
      providers: ['dahl', 'openrouter'],
    }),
  )
  const { sdk } = await mount({ endpoint })
  const status = await sdk.status()
  assert.equal(status.ok, true)
  assert.equal(status.accounts.total, 212)
  assert.equal(status.accounts.active, 185)
  assert.deepEqual(status.accounts.byProvider, { dahl: 108, openrouter: 54 })
  assert.equal(status.omniroute.running, true)
  assert.equal(status.omniroute.connections, 721)
  assert.deepEqual(status.providers, ['dahl', 'openrouter'])
})

test('a status body that grew an account list does not carry it through', async () => {
  const endpoint = await serving((_req, respond) =>
    respond(200, {
      accounts: {
        total: 1,
        active: 1,
        byProvider: { dahl: 1 },
        list: [{ email: 'leak@example.com', apiKey: 'sk-live-leak' }],
      },
      omniroute: { running: false, connections: 0 },
      providers: [],
    }),
  )
  const { sdk } = await mount({ endpoint })
  const serialised = JSON.stringify(await sdk.status())
  assert.ok(!serialised.includes('sk-live-leak'), serialised)
  assert.ok(!serialised.includes('leak@example.com'), serialised)
})

test('providers is a plain list of names', async () => {
  const endpoint = await serving((_req, respond) => respond(200, { providers: ['dahl', 'groq', 'mistral'] }))
  const { sdk } = await mount({ endpoint })
  assert.deepEqual(await sdk.providers(), ['dahl', 'groq', 'mistral'])
})

test('nothing listening is reported as nothing listening, not as a timeout', async () => {
  // Two different operator actions. Reporting one as the other sends someone
  // looking at latency when the process is not running.
  const { sdk } = await mount({ endpoint: 'http://127.0.0.1:1' })
  const result = await sdk.trigger('dahl')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /nothing is listening|did not answer/)
})

test('a provisioner that never answers is a timeout, and the row survives it', async () => {
  const endpoint = await serving(() => {
    /* deliberately never responds */
  })
  const { sdk } = await mount({ endpoint, triggerTimeoutMs: 200 })
  const result = await sdk.trigger('dahl')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /did not answer in time/)
  // And the row is still usable afterwards — a timeout is not a poisoned row.
  assert.equal((await sdk.report()).failures, 1)
})

test('switched off, it mounts, reports, and calls nothing', async () => {
  let reached = false
  const endpoint = await serving((_req, respond) => {
    reached = true
    respond(200, ASYNC_ACCEPTED)
  })
  const { sdk } = await mount({ endpoint, enabled: false })
  assert.equal((await sdk.trigger('dahl')).ok, false)
  assert.deepEqual(await sdk.providers(), [])
  assert.equal((await sdk.status()).ok, false)
  assert.equal(reached, false)
  assert.equal((await sdk.report()).enabled, false)
})

test('an unload waits for a trigger in flight rather than cutting it off', async () => {
  // A killed trigger does not stop a signup the provisioner already started; it
  // only removes the process that knew about it.
  let release: (() => void) | undefined
  const endpoint = await serving((_req, respond) => {
    release = () => respond(200, ASYNC_ACCEPTED)
  })
  const { fiber, sdk } = await mount({ endpoint, drainMs: 2_000 })

  const pending = sdk.trigger('dahl')
  await settle(50)
  const disposed = fiber.dispose()
  await settle(50)
  let finished = false
  void pending.then(() => {
    finished = true
  })
  assert.equal(finished, false, 'the call was abandoned before the drain could wait for it')
  release?.()
  const result = await pending
  assert.equal(result.triggered, true)
  await disposed
})

test('report counts what happened, and probe says whether anything is there', async () => {
  const endpoint = await serving((req, respond) =>
    req.url === '/health' ? respond(200, { ok: true, service: 'provisioner-sdk' }) : respond(200, ASYNC_ACCEPTED),
  )
  const { sdk } = await mount({ endpoint })
  await sdk.trigger('dahl')
  const report: any = await sdk.report(true)
  assert.equal(report.calls >= 1, true)
  assert.equal(report.probe.ok, true)
  assert.equal(report.probe.status, 200)
})

test('scrub is not the defence, but it holds the line it is given', () => {
  assert.ok(!scrub('key sk-live-abcdefgh12345678 here').includes('abcdefgh'))
  assert.ok(!scrub('"apiKey": "zzzzzzzzzzzzzzzz"').includes('zzzz'))
  assert.ok(!scrub('mail auto-1@example.com now').includes('example.com'))
})
