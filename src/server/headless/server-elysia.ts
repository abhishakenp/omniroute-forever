/**
 * Bun.serve headless API gateway.
 *
 * Thin API server using Bun.serve directly (no Elysia). Route handlers in
 * src/app/api/ export GET/POST/etc functions taking (Request, RouteContext).
 *
 * Usage:
 *   bun src/server/headless/server-elysia.ts
 *   bun src/server/headless/server-elysia.ts --port 20128
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { handleThinGateway } from "./thinGateway.ts";
import { failureResponse, type FailureCode } from "./failureDomain.ts";
import { startStdoutLogRotation, resolveStdoutLogPath } from "../../lib/stdoutLogRotation.ts";
import { parseChatBody } from "./parseChatBody.ts";
import {
  apiDirFor,
  discoverRoutes,
  HTTP_METHODS,
  loadRouteHandler,
  matchRoute,
  type CompiledRoute,
  type RouteContext,
  type RouteHandler,
} from "./coreRoutes.ts";

// ── Load DATA_DIR/.env into process.env (if not already set) ──────────────
(() => {
  const dataDir = process.env.DATA_DIR || join(process.env.HOME || "", ".omniroute");
  const envPath = join(dataDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
})();

// ── Route discovery lives in coreRoutes.ts, shared with the Cordis gateway row ──

const API_DIR = apiDirFor(process.cwd());

// ── Concurrency control ─────────────────────────────────────────────────────

/**
 * How many upstream requests this router will carry at once.
 *
 * This is not only an admission-control number. `/health` publishes it, and
 * RLM's `capacity.ts` reads it there to size its own fleet of agent
 * subprocesses — so a ceiling chosen for a server became a subprocess count on
 * a laptop. RLM's own comment recorded the consequence: "measured here it
 * answered 64 ... so on this machine it is not the binding constraint and
 * memory is", i.e. the fleet grew until RAM stopped it, and the machine became
 * unusable before the router ever refused anything.
 *
 * So the default is derived from the machine rather than fixed. Four per core
 * keeps a router that is mostly waiting on sockets busy without pretending a
 * laptop is a datacentre, and the cap keeps a large host from re-creating the
 * original number by accident. An operator who genuinely wants more sets
 * OMNIROUTE_MAX_CONCURRENT and gets exactly what they asked for.
 */
const DEFAULT_MAX_CONCURRENT = Math.min(32, Math.max(4, (os.cpus()?.length || 4) * 4));
const MAX_CONCURRENT = Number(process.env.OMNIROUTE_MAX_CONCURRENT || DEFAULT_MAX_CONCURRENT);
const MAX_CONCURRENT_INTERNAL = Number(process.env.OMNIROUTE_MAX_CONCURRENT_INTERNAL || 16);
const MAX_QUEUE_DEPTH = Number(process.env.OMNIROUTE_MAX_QUEUE_DEPTH || 500);
const QUEUE_TIMEOUT_MS = Number(process.env.OMNIROUTE_QUEUE_TIMEOUT_MS || 30_000);
const MAX_BODY_BYTES = Number(process.env.OMNIROUTE_MAX_BODY_BYTES || 2 * 1024 * 1024);

let inFlight = 0;
let internalInFlight = 0;

interface QueueEntry { cancelled: boolean; run(): void; }
const requestQueue: QueueEntry[] = [];
const internalQueue: QueueEntry[] = [];

class QueueRejectedError extends Error {
  constructor(msg: string, readonly reason: "queue-full" | "queue-timeout" | "client-disconnected") {
    super(msg); this.name = "QueueRejectedError";
  }
}

/**
 * Local admission-control reasons -> the shared refusal contract.
 *
 * Every one of these is OmniRoute refusing to START work; none of them means an
 * upstream provider failed. Keeping the mapping in one table is what lets a
 * caller tell this apart from the gateway's upstream-exhaustion refusal, which
 * used to be byte-identical (503 + Retry-After: 5). See failureDomain.ts.
 */
const QUEUE_REASON_TO_FAILURE: Record<QueueRejectedError["reason"], FailureCode> = {
  "queue-full": "admission_queue_full",
  "queue-timeout": "admission_queue_timeout",
  "client-disconnected": "client_disconnected",
};

/** Build the refusal response for a rejected admission attempt. */
function admissionRejectionResponse(err: QueueRejectedError): Response {
  return failureResponse(QUEUE_REASON_TO_FAILURE[err.reason], err.message);
}

function tryAcquire(isInternal: boolean): boolean {
  if (isInternal) { if (internalInFlight >= MAX_CONCURRENT_INTERNAL) return false; internalInFlight++; return true; }
  if (inFlight >= MAX_CONCURRENT) return false; inFlight++; return true;
}

function acquireSlot(isInternal: boolean, signal?: AbortSignal): Promise<void> {
  if (tryAcquire(isInternal)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new QueueRejectedError("Client disconnected", "client-disconnected"));
  const queue = isInternal ? internalQueue : requestQueue;
  if (queue.length >= MAX_QUEUE_DEPTH) return Promise.reject(new QueueRejectedError(`Queue full (${MAX_QUEUE_DEPTH})`, "queue-full"));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry: QueueEntry = { cancelled: false, run: () => settle(true) };
    const settle = (granted: boolean, err?: QueueRejectedError) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (granted) { if (isInternal) internalInFlight++; else inFlight++; resolve(); }
      else { entry.cancelled = true; reject(err); }
    };
    const onAbort = () => settle(false, new QueueRejectedError("Client disconnected", "client-disconnected"));
    timer = setTimeout(() => settle(false, new QueueRejectedError(`Waited ${QUEUE_TIMEOUT_MS}ms`, "queue-timeout")), QUEUE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(entry);
  });
}

function releaseSlot(isInternal: boolean) {
  if (isInternal) internalInFlight--; else inFlight--;
  const queue = isInternal ? internalQueue : requestQueue;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!next.cancelled) { next.run(); return; }
  }
}

function isInternalRequest(req: Request): boolean {
  return Boolean(req.headers.get("x-model-sync-internal-auth"));
}

// ── Server ──────────────────────────────────────────────────────────────────

let discoveredRoutes: CompiledRoute[] = [];

function healthResponse(): Response {
  return Response.json({
    status: "ok", mode: "bun",
    inFlight, queued: requestQueue.length,
    internalInFlight, internalQueued: internalQueue.length,
    maxConcurrent: MAX_CONCURRENT, queueDepthCap: MAX_QUEUE_DEPTH, queueWaitTimeoutMs: QUEUE_TIMEOUT_MS,
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Health — bypass concurrency control
  if (path === "/health" || path === "/") return healthResponse();

  // Thin gateway — ALL /v1/chat/completions go through the iterator pattern.
  // No combo routing engine, no in-memory state, no TransformStream buffers.
  if (path === "/v1/chat/completions" && request.method === "POST") {
    try {
      const parsed = await parseChatBody(request);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      const model = String(body.model || "auto/best-free");
      const stream = body.stream === true;

      try {
        // Pass the client's abort signal: without it the `client-disconnected`
        // branch of acquireSlot() was unreachable, so a caller that hung up
        // while queued still consumed a slot when its turn arrived.
        await acquireSlot(isInternalRequest(request), request.signal);
      } catch (err) {
        if (err instanceof QueueRejectedError) return admissionRejectionResponse(err);
        throw err;
      }
      try {
        return await handleThinGateway({ body, model, stream, signal: request.signal });
      } finally {
        releaseSlot(isInternalRequest(request));
      }
    } catch (err) {
      console.error("[gateway] Thin gateway error:", err);
      return Response.json({ error: { message: "Gateway error", type: "server_error" } }, { status: 500 });
    }
  }

  let routePath = path;
  if (!routePath.startsWith("/api/")) routePath = "/api" + routePath;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: { message: `Body too large (${contentLength} bytes, max ${MAX_BODY_BYTES})`, type: "invalid_request" } }, { status: 413 });
  }

  const match = matchRoute(routePath, discoveredRoutes);
  if (!match) return Response.json({ error: { message: "Not found", type: "not_found" } }, { status: 404 });

  let handler: RouteHandler;
  try { handler = await loadRouteHandler(match.route); }
  catch (err) {
    console.error(`[gateway] Failed to load route ${match.route.originalPath}:`, err);
    return Response.json({ error: { message: "Route module load failed", type: "server_error" } }, { status: 500 });
  }

  const method = request.method.toUpperCase();
  const methodFn = handler[method as keyof RouteHandler];
  if (typeof methodFn !== "function") {
    const allow = HTTP_METHODS.filter((m) => typeof handler[m] === "function").join(", ");
    return Response.json({ error: { message: `Method ${method} not allowed`, type: "invalid_request" } }, { status: 405, headers: { Allow: allow } });
  }

  const ctx: RouteContext = { params: match.params, searchParams: url.searchParams };
  const internal = isInternalRequest(request);

  try {
    await acquireSlot(internal, request.signal);
    try {
      return await methodFn(request, ctx);
    } finally {
      releaseSlot(internal);
    }
  } catch (err) {
    if (err instanceof QueueRejectedError) {
      console.warn(`[gateway] ${err.message}`);
      return admissionRejectionResponse(err);
    }
    console.error("[gateway] Unhandled error:", err);
    return Response.json({ error: { message: "Internal server error", type: "server_error" } }, { status: 500 });
  }
}

async function startServer(opts: { port?: number; hostname?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 20128);
  const hostname = opts.hostname ?? process.env.HOST ?? "0.0.0.0";

  // Rotate the daemon's own stdout log. This is the ONLY entrypoint launchd
  // actually execs, and rotation has to be periodic here (not startup-only) or
  // a KeepAlive daemon never checks again — which is how omniroute.log reached
  // 54 MB beside five empty archives. See stdoutLogRotation.ts.
  try {
    const dataDir = process.env.DATA_DIR || join(process.env.HOME || "", ".omniroute");
    const stdoutLog = resolveStdoutLogPath(dataDir);
    if (stdoutLog) {
      startStdoutLogRotation(stdoutLog);
      console.log(`[gateway] stdout log rotation armed for ${stdoutLog}`);
    } else {
      console.log("[gateway] stdout log rotation skipped — no log file to watch");
    }
  } catch (err) {
    console.warn("[gateway] stdout log rotation setup failed:", err);
  }

  console.log("[gateway] Discovering API routes...");
  discoveredRoutes = discoverRoutes(API_DIR);
  console.log(`[gateway] ${discoveredRoutes.length} core routes loaded (t=${Math.round(performance.now())}ms)`);

  // Register local-CLI passthrough providers (auggie, …) so they are visible in
  // /providers + /v1/models and, crucially, own a connection row that the
  // failover path can quarantine when the CLI runs out of credits.
  try {
    const { seedLocalCliConnections } = await import("../../lib/db/seedLocalCliConnections.ts");
    seedLocalCliConnections();
    console.log(`[gateway] local-CLI connections seeded, DB open (t=${Math.round(performance.now())}ms)`);
  } catch (err) {
    console.warn("[gateway] local-CLI connection seeding failed:", err);
  }

  // Retry port binding — launchd's KeepAlive can restart before the old
  // process has released the port, producing "Failed to start server. Is
  // port 20128 in use?" 1,875 times in one log. Wait and retry instead of
  // exiting immediately.
  let server: ReturnType<typeof Bun.serve> | undefined;
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      server = Bun.serve({
        port,
        hostname,
        maxRequestBodySize: MAX_BODY_BYTES,
        fetch: handleRequest,
      });
      break;
    } catch (err: any) {
      if (attempt < maxRetries && /port.*in use|EADDRINUSE/i.test(String(err?.message ?? err))) {
        console.warn(`[gateway] Port ${port} in use (attempt ${attempt}/${maxRetries}) — retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw err;
      }
    }
  }

  // Time since the process began, so a slow cold start shows in the log
  // instead of only as failed requests upstream.
  console.log(
    `[gateway] Server listening on http://${hostname}:${port} ` +
      `(${Math.round(performance.now())}ms after process start, ${new Date().toISOString()})`
  );
  console.log(`[gateway] RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

  process.on("SIGTERM", () => { console.log("[gateway] SIGTERM — shutting down"); process.exit(0); });
  process.on("SIGINT", () => { console.log("[gateway] SIGINT — shutting down"); process.exit(0); });
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let hostname: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) { port = Number(args[i + 1]); i++; }
    else if (args[i] === "--host" && args[i + 1]) { hostname = args[i + 1]; i++; }
  }
  startServer({ port, hostname }).catch((err) => { console.error("[gateway] Fatal:", err); process.exit(1); });
}
