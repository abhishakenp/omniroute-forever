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

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { handleThinGateway } from "./thinGateway.ts";

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

// ── Route discovery (same logic as router.ts, simplified) ───────────────────

interface RouteHandler {
  GET?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  POST?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  PUT?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  DELETE?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  PATCH?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  OPTIONS?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  HEAD?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
}

interface RouteContext {
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
}

type Segment =
  | { type: "literal"; value: string }
  | { type: "param"; name: string }
  | { type: "catch-all"; name: string }
  | { type: "optional-catch-all"; name: string };

interface CompiledRoute {
  originalPath: string;
  segments: Segment[];
  modulePath: string;
  specificity: number;
}

const API_DIR = join(process.cwd(), "src", "app", "api");
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const;

// Core directory prefixes (relative to /api/) — only these are loaded
const CORE_DIRS: string[] = [
  "v1/chat/completions", "v1/messages", "v1/completions", "v1/responses",
  "v1/embeddings", "v1/moderations", "v1/rerank",
  "v1/audio/", "v1/images/", "v1/files",
  "v1/models", "v1/models/",
  "v1/combos", "v1/quotas/check", "v1/me/status",
  "v1/registered-keys", "v1/ws",
  "v1/providers/",
  "providers", "combos", "keys",
  "monitoring", "health", "health/",
  "synced-available-models", "free-models", "free-tier", "free-provider-rankings",
  "resilience",
  "auth/status", "auth/login", "auth/logout",
];

function isCoreRoute(originalPath: string): boolean {
  const rel = originalPath.replace(/^\/api\//, "");
  return CORE_DIRS.some((d) => rel === d || rel.startsWith(d + "/") || rel.startsWith(d));
}

function discoverRoutes(apiDir: string = API_DIR): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  function scan(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) scan(fullPath);
      else if (entry === "route.ts" || entry === "route.tsx") {
        const relativePath = relative(apiDir, fullPath);
        const routePath = "/api/" + relativePath.replace(/\/route\.tsx?$/, "").split(sep).join("/");
        const compiled = compileRoute(routePath, fullPath);
        if (isCoreRoute(routePath)) routes.push(compiled);
      }
    }
  }
  scan(apiDir);
  routes.sort((a, b) => b.specificity - a.specificity);
  return routes;
}

function compileRoute(routePath: string, modulePath: string): CompiledRoute {
  const rawSegments = routePath.split("/").filter(Boolean);
  const segments: Segment[] = [];
  let specificity = 0;
  for (const seg of rawSegments) {
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      segments.push({ type: "catch-all", name: seg.slice(4, -1) });
      specificity -= 10;
    } else if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      segments.push({ type: "optional-catch-all", name: seg.slice(5, -2) });
      specificity -= 5;
    } else if (seg.startsWith("[") && seg.endsWith("]")) {
      segments.push({ type: "param", name: seg.slice(1, -1) });
      specificity += 1;
    } else {
      segments.push({ type: "literal", value: decodeURIComponent(seg) });
      specificity += 10;
    }
  }
  return { originalPath: routePath, segments, modulePath, specificity };
}

function tryMatch(pathSegments: string[], routeSegments: Segment[]): Record<string, string | string[]> | null {
  const params: Record<string, string | string[]> = {};
  let pi = 0, ri = 0;
  while (ri < routeSegments.length) {
    const seg = routeSegments[ri];
    if (seg.type === "literal") {
      if (pi >= pathSegments.length || decodeURIComponent(pathSegments[pi]) !== seg.value) return null;
      pi++; ri++;
    } else if (seg.type === "param") {
      if (pi >= pathSegments.length) return null;
      params[seg.name] = decodeURIComponent(pathSegments[pi]);
      pi++; ri++;
    } else if (seg.type === "catch-all") {
      const remaining = pathSegments.slice(pi);
      params[seg.name] = remaining.length === 0 ? [] : remaining.map((s) => decodeURIComponent(s));
      pi = pathSegments.length; ri++;
      if (ri < routeSegments.length) return null;
    } else if (seg.type === "optional-catch-all") {
      const remaining = pathSegments.slice(pi);
      params[seg.name] = remaining.map((s) => decodeURIComponent(s));
      pi = pathSegments.length; ri++;
      if (ri < routeSegments.length) return null;
    }
  }
  if (pi < pathSegments.length) return null;
  return params;
}

function matchRoute(path: string, routes: CompiledRoute[]) {
  const pathSegments = path.split("/").filter(Boolean);
  for (const route of routes) {
    const params = tryMatch(pathSegments, route.segments);
    if (params !== null) return { route, params };
  }
  return null;
}

// ── Module cache ────────────────────────────────────────────────────────────

const moduleCache = new Map<string, RouteHandler>();

async function loadRouteHandler(route: CompiledRoute): Promise<RouteHandler> {
  const cached = moduleCache.get(route.modulePath);
  if (cached) return cached;
  const fileUrl = `file://${route.modulePath}`;
  const mod = await import(fileUrl);
  const handler: RouteHandler = {};
  for (const method of HTTP_METHODS) {
    if (typeof mod[method] === "function") handler[method] = mod[method];
  }
  moduleCache.set(route.modulePath, handler);
  return handler;
}

// ── Concurrency control ─────────────────────────────────────────────────────

const MAX_CONCURRENT = Number(process.env.OMNIROUTE_MAX_CONCURRENT || 64);
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
      const body = await request.json() as Record<string, unknown>;
      const model = String(body.model || "auto/best-free");
      const stream = body.stream === true;

      try {
        await acquireSlot(isInternalRequest(request));
      } catch (err) {
        if (err instanceof QueueRejectedError) {
          return Response.json({ error: { message: err.message, type: "server_error", code: `queue_${err.reason}` } }, { status: 503, headers: { "Retry-After": "5" } });
        }
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
    await acquireSlot(internal);
    try {
      return await methodFn(request, ctx);
    } finally {
      releaseSlot(internal);
    }
  } catch (err) {
    if (err instanceof QueueRejectedError) {
      console.warn(`[gateway] ${err.message}`);
      return Response.json({ error: { message: err.message, type: "server_error", code: `queue_${err.reason}` } }, { status: 503, headers: { "Retry-After": "5" } });
    }
    console.error("[gateway] Unhandled error:", err);
    return Response.json({ error: { message: "Internal server error", type: "server_error" } }, { status: 500 });
  }
}

async function startServer(opts: { port?: number; hostname?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 20128);
  const hostname = opts.hostname ?? process.env.HOST ?? "0.0.0.0";

  console.log("[gateway] Discovering API routes...");
  discoveredRoutes = discoverRoutes();
  console.log(`[gateway] ${discoveredRoutes.length} core routes loaded`);

  // Register local-CLI passthrough providers (auggie, …) so they are visible in
  // /providers + /v1/models and, crucially, own a connection row that the
  // failover path can quarantine when the CLI runs out of credits.
  try {
    const { seedLocalCliConnections } = await import("../../lib/db/seedLocalCliConnections.ts");
    seedLocalCliConnections();
  } catch (err) {
    console.warn("[gateway] local-CLI connection seeding failed:", err);
  }

  Bun.serve({
    port,
    hostname,
    maxRequestBodySize: MAX_BODY_BYTES,
    fetch: handleRequest,
  });

  console.log(`[gateway] Server listening on http://${hostname}:${port}`);
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
