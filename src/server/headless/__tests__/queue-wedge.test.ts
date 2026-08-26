/**
 * Regression tests for the heavy-load chat wedge (headless semaphore).
 *
 * Under mass account exhaustion, slow upstream cascades pinned every request
 * slot; new arrivals queued UNBOUNDED with no server-side deadline and no
 * client-disconnect propagation, so abandoned requests wedged the queue while
 * /health stayed 200. These tests pin the three fixes:
 *
 *  1. queue depth cap        -> overflow rejected 503 immediately
 *  2. queue wait deadline    -> waiters rejected 503 after OMNIROUTE_QUEUE_TIMEOUT_MS
 *  3. disconnect abort       -> dead clients free their slot; queue drains
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SERVER_TS = path.join(REPO_ROOT, "src/server/headless/server.ts");
const RUNNER = path.join(REPO_ROOT, "tests/fixtures/headless-queue/server.mts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

interface Handle {
  child: ChildProcess;
  port: number;
  output: string;
}

const children: ChildProcess[] = [];

async function startServer(env: Record<string, string>): Promise<Handle> {
  const child = spawn(TSX, [RUNNER], {
    env: { ...process.env, HEADLESS_SERVER_TS: SERVER_TS, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`runner timeout. Output:\n${output}`)), 20_000);
    child.stdout!.on("data", (c: Buffer) => {
      const m = c.toString().match(/READY PORT=(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", () => {
      clearTimeout(t);
      reject(new Error(`runner exited early. Output:\n${output}`));
    });
  });
  return { child, port, output };
}

function request(
  port: number,
  pathName: string,
  opts: { method?: string; timeoutMs?: number; destroyAfterMs?: number } = {}
): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: pathName, method: opts.method ?? "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    r.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    if (opts.timeoutMs) {
      r.setTimeout(opts.timeoutMs, () => r.destroy(new Error("client-timeout")));
    }
    if (opts.destroyAfterMs !== undefined) {
      setTimeout(() => r.destroy(), opts.destroyAfterMs);
    }
    r.end();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

interface HealthSnapshot {
  httpStatus: number;
  inFlight: number;
  queued: number;
}

async function health(h: Handle): Promise<HealthSnapshot> {
  const res = await request(h.port, "/health");
  const raw = JSON.parse(res.body) as { inFlight?: number; queued?: number };
  return { httpStatus: res.status, inFlight: raw.inFlight ?? 0, queued: raw.queued ?? 0 };
}

afterEach(() => {
  for (const c of children.splice(0)) {
    if (!c.killed) c.kill("SIGKILL");
  }
});

describe("headless server queue anti-wedge", () => {
  it("rejects overflow immediately when queue depth cap is hit", async () => {
    const h = await startServer({
      OMNIROUTE_MAX_CONCURRENT: "1",
      OMNIROUTE_MAX_CONCURRENT_INTERNAL: "32",
      OMNIROUTE_MAX_QUEUE_DEPTH: "2",
      OMNIROUTE_QUEUE_TIMEOUT_MS: "60000",
    });

    // Occupy the single slot.
    void request(h.port, "/api/wedge-slow?ms=30000", { method: "POST" });
    await waitFor(async () => (await health(h)).inFlight === 1, 5000, "holder to take slot");

    // Two fit in the queue, three more must be rejected right away.
    const floods = Array.from({ length: 5 }, () =>
      request(h.port, "/api/wedge-slow?ms=30000", { method: "POST", timeoutMs: 8000 })
    );
    await sleep(700);
    const hp = await health(h);
    expect(hp.httpStatus).toBe(200);
    expect(hp.inFlight).toBe(1);
    expect(hp.queued).toBe(2);

    const results = await Promise.all(floods);
    const fast503 = results.filter((r) => r.status === 503 && r.body.includes("queue_queue-full"));
    expect(fast503.length).toBe(3);

    // Health must stay responsive throughout.
    const t0 = Date.now();
    const finalHealth = await health(h);
    expect(finalHealth.httpStatus).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);

  it("rejects queued waiters with 503 after the server-side wait deadline", async () => {
    const h = await startServer({
      OMNIROUTE_MAX_CONCURRENT: "1",
      OMNIROUTE_MAX_CONCURRENT_INTERNAL: "32",
      OMNIROUTE_MAX_QUEUE_DEPTH: "10",
      OMNIROUTE_QUEUE_TIMEOUT_MS: "1500",
    });

    void request(h.port, "/api/wedge-slow?ms=30000", { method: "POST" });
    await waitFor(async () => (await health(h)).inFlight === 1, 5000, "holder to take slot");

    const t0 = Date.now();
    const floods = Array.from({ length: 3 }, () =>
      request(h.port, "/api/wedge-slow?ms=30000", { method: "POST", timeoutMs: 10_000 })
    );
    const results = await Promise.all(floods);
    const elapsed = Date.now() - t0;

    for (const r of results) {
      expect(r.status).toBe(503);
      expect(r.body).toContain("queue_queue-timeout");
    }
    // Deadline (~1.5s), well below the old indefinite hang / client 90s timeouts.
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(5000);
    expect((await health(h)).httpStatus).toBe(200);
  }, 30_000);

  it("frees the slot when a client disconnects mid-stream while parked on backpressure drain", async () => {
    const h = await startServer({
      OMNIROUTE_MAX_CONCURRENT: "1",
      OMNIROUTE_MAX_CONCURRENT_INTERNAL: "32",
      OMNIROUTE_MAX_QUEUE_DEPTH: "10",
      OMNIROUTE_QUEUE_TIMEOUT_MS: "60000",
    });

    // Start an SSE stream that outruns the client, then pause reading so the
    // server parks in its backpressure drain wait, then destroy the socket.
    const parked = await new Promise<{ r: http.ClientRequest }>((resolve) => {
      const r = http.request(
        { host: "127.0.0.1", port: h.port, path: "/api/wedge-sse", method: "POST" },
        (res) => {
          res.once("data", () => resolve({ r })); // got first chunk; stop reading now
        }
      );
      r.on("error", () => {});
      r.end();
    });
    parked.r.socket?.pause();
    await sleep(1000); // let the server fill buffers and park on drain
    expect((await health(h)).inFlight).toBe(1);
    parked.r.destroy();

    // The dead socket must release the slot instead of pinning it forever.
    await waitFor(
      async () => (await health(h)).inFlight === 0,
      8000,
      "slot to free after mid-stream disconnect"
    );

    const served = await request(h.port, "/api/wedge-slow?ms=100", {
      method: "POST",
      timeoutMs: 5000,
    });
    expect(served.status).toBe(200);
  }, 30_000);

  it("frees the slot when a client disconnects while the server awaits the next upstream chunk", async () => {
    const h = await startServer({
      OMNIROUTE_MAX_CONCURRENT: "1",
      OMNIROUTE_MAX_CONCURRENT_INTERNAL: "32",
      OMNIROUTE_MAX_QUEUE_DEPTH: "10",
      OMNIROUTE_QUEUE_TIMEOUT_MS: "60000",
    });

    // Slow stream: writes stay under the high-water mark (never park on
    // drain), so the server sits inside reader.read() between chunks.
    // Destroying the client mid-read must still free the slot.
    let victim: http.ClientRequest | null = null;
    await new Promise<void>((resolve) => {
      victim = http.request(
        { host: "127.0.0.1", port: h.port, path: "/api/wedge-sse?mode=slow", method: "POST" },
        (res) => {
          res.once("data", () => resolve()); // got first chunk; server now awaits chunk 2
        }
      );
      victim.on("error", () => {});
      victim.end();
    });
    expect((await health(h)).inFlight).toBe(1);
    victim!.destroy();

    await waitFor(
      async () => (await health(h)).inFlight === 0,
      6000,
      "slot to free after mid-read disconnect"
    );

    const served = await request(h.port, "/api/wedge-slow?ms=100", {
      method: "POST",
      timeoutMs: 5000,
    });
    expect(served.status).toBe(200);
  }, 30_000);

  it("drains the queue and frees slots when clients disconnect", async () => {
    const h = await startServer({
      OMNIROUTE_MAX_CONCURRENT: "1",
      OMNIROUTE_MAX_CONCURRENT_INTERNAL: "32",
      OMNIROUTE_MAX_QUEUE_DEPTH: "10",
      OMNIROUTE_QUEUE_TIMEOUT_MS: "60000",
    });

    // Holder's client disconnects at t=2s -> its in-flight handler must be
    // aborted via request.signal and its slot freed.
    void request(h.port, "/api/wedge-slow?ms=60000", { method: "POST", destroyAfterMs: 2000 });
    await waitFor(async () => (await health(h)).inFlight === 1, 5000, "holder to take slot");

    // Flood: 4 clients that give up (disconnect) after 1s, while the slot is
    // still held. Their queue entries must be cancelled, not left pinned.
    const floods = Array.from({ length: 4 }, () =>
      request(h.port, "/api/wedge-slow?ms=60000", { method: "POST", destroyAfterMs: 1000 })
    );
    await waitFor(async () => (await health(h)).queued === 4, 5000, "flood to fill queue");
    void floods;

    await waitFor(
      async () => {
        const s = await health(h);
        return s.httpStatus === 200 && s.queued === 0 && s.inFlight === 0;
      },
      8000,
      "queue+slots to fully drain after disconnects"
    );

    // Server must accept and serve new work again right away.
    const fresh = await request(h.port, "/health");
    expect(fresh.status).toBe(200);
    const served = await request(h.port, "/api/wedge-slow?ms=100", {
      method: "POST",
      timeoutMs: 5000,
    });
    expect(served.status).toBe(200);
    expect(JSON.parse(served.body).ok).toBe(true);
  }, 30_000);
});
