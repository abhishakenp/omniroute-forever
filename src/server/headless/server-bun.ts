/**
 * Bun-native headless API server.
 *
 * Replaces the Node.js headless server for API-only deployments.
 * Uses Bun.serve() which gives native Web API Request/Response — no
 * node:http → Web API conversion needed. Route handlers are the same
 * Next.js App Router handlers (export GET/POST/...), auto-discovered
 * from src/app/api/.
 *
 * Memory: Bun's runtime overhead is ~50-80MB vs Node.js's ~300-400MB.
 * The provisioner (also Bun) runs at ~180MB RSS; this server targets
 * <400MB total with the same route handlers.
 *
 * Usage:
 *   bun src/server/headless/server-bun.ts
 *   bun src/server/headless/server-bun.ts --port 20128
 */

import {
  discoverRoutes,
  matchRoute,
  loadRouteHandler,
  preloadRoutes,
  type RouteContext,
  type CompiledRoute,
} from "./router.ts";
import { classifyRoute, scanRouteTier } from "./route-manifest.ts";

// ── Route filtering ─────────────────────────────────────────────────────────
// Routes are classified into tiers by the route manifest (route-manifest.ts).
// The headless server loads only `core` routes — chat, models, providers,
// combos, keys, health, auth, resilience. Dashboard/optional routes (640+)
// are skipped to avoid loading their dependency trees at startup.
//
// New routes in core directories (v1/, providers/, combos/, etc.) are
// automatically included. Routes can export `routeTier` to override.
function discoverCoreRoutes(): CompiledRoute[] {
  const all = discoverRoutes();
  const core = all.filter((r) => {
    const override = scanRouteTier(r.modulePath);
    return classifyRoute(r.originalPath, override) === "core";
  });
  console.log(`[bun] ${core.length}/${all.length} routes loaded (core-only mode)`);
  // Log skipped categories for visibility
  const skipped = all.filter((r) => {
    const override = scanRouteTier(r.modulePath);
    return classifyRoute(r.originalPath, override) !== "core";
  });
  const skippedCats = new Set(
    skipped.map((r) => r.originalPath.split("/").slice(2, 4).join("/"))
  );
  if (skipped.length > 0) {
    console.log(
      `[bun] Skipped ${skipped.length} routes (${[...skippedCats].slice(0, 10).join(", ")}…)`
    );
  }
  return core;
}

// ── Concurrency control ────────────────────────────────────────────────────
// Same two-tier semaphore as the Node server: client slots + internal slots.
// Internal requests (ModelSync, DynamicFreeCombo) use a separate pool so
// background work can't starve client requests.
const MAX_CONCURRENT_REQUESTS = Number(process.env.OMNIROUTE_MAX_CONCURRENT || 8);
const MAX_CONCURRENT_INTERNAL = Number(process.env.OMNIROUTE_MAX_CONCURRENT_INTERNAL || 8);
const MAX_QUEUE_DEPTH = Number(process.env.OMNIROUTE_MAX_QUEUE_DEPTH || 100);
const QUEUE_WAIT_TIMEOUT_MS = Number(process.env.OMNIROUTE_QUEUE_TIMEOUT_MS || 30_000);
const MAX_BODY_BYTES = Number(process.env.OMNIROUTE_MAX_BODY_BYTES || 2 * 1024 * 1024);

let inFlight = 0;
let internalInFlight = 0;

interface QueueEntry {
  cancelled: boolean;
  run(): void;
}
const requestQueue: QueueEntry[] = [];
const internalQueue: QueueEntry[] = [];

class QueueRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: "queue-full" | "queue-timeout" | "client-disconnected"
  ) {
    super(message);
    this.name = "QueueRejectedError";
  }
}

function tryAcquireImmediate(isInternal: boolean): boolean {
  if (isInternal) {
    if (internalInFlight >= MAX_CONCURRENT_INTERNAL) return false;
    internalInFlight++;
    return true;
  }
  if (inFlight >= MAX_CONCURRENT_REQUESTS) return false;
  inFlight++;
  return true;
}

function acquireSlot(isInternal: boolean, signal?: AbortSignal): Promise<void> {
  if (tryAcquireImmediate(isInternal)) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(
      new QueueRejectedError("Client disconnected while waiting for a slot", "client-disconnected")
    );
  }
  const queue = isInternal ? internalQueue : requestQueue;
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(
      new QueueRejectedError(
        `Request queue full (${MAX_QUEUE_DEPTH} waiting); rejecting early`,
        "queue-full"
      )
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry: QueueEntry = {
      cancelled: false,
      run: () => settle(true),
    };
    const settle = (granted: boolean, err?: QueueRejectedError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (granted) {
        if (isInternal) internalInFlight++;
        else inFlight++;
        resolve();
      } else {
        entry.cancelled = true;
        reject(err);
      }
    };
    const onAbort = () =>
      settle(
        false,
        new QueueRejectedError(
          "Client disconnected while waiting for a slot",
          "client-disconnected"
        )
      );
    timer = setTimeout(
      () =>
        settle(
          false,
          new QueueRejectedError(
            `Waited ${QUEUE_WAIT_TIMEOUT_MS}ms for a slot; rejecting`,
            "queue-timeout"
          )
        ),
      QUEUE_WAIT_TIMEOUT_MS
    );
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(entry);
  });
}

function releaseSlot(isInternal: boolean): void {
  if (isInternal) internalInFlight--;
  else inFlight--;
  const queue = isInternal ? internalQueue : requestQueue;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!next.cancelled) {
      next.run();
      return;
    }
  }
}

function isInternalRequest(req: Request): boolean {
  return Boolean(req.headers.get("x-model-sync-internal-auth"));
}

function getAllowHeader(handler: Record<string, unknown>): string {
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].filter(
    (m) => typeof handler[m] === "function"
  );
  return methods.join(", ");
}

// ── Route serving ──────────────────────────────────────────────────────────

async function handleRequest(
  req: Request,
  routes: ReturnType<typeof discoverRoutes>,
  signal?: AbortSignal
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Normalize: routes are registered with /api prefix
  let routePath = path;
  if (!routePath.startsWith("/api/")) {
    routePath = "/api" + routePath;
  }

  const match = matchRoute(routePath, routes);
  if (!match) {
    return Response.json({ error: { message: "Not found", type: "not_found" } }, { status: 404 });
  }

  let handler;
  try {
    handler = await loadRouteHandler(match.route);
  } catch (error) {
    console.error(`[bun] Failed to load route ${match.route.originalPath}:`, error);
    return Response.json(
      { error: { message: "Route module load failed", type: "server_error" } },
      { status: 500 }
    );
  }

  const method = req.method.toUpperCase();
  const methodFn = (handler as Record<string, unknown>)[method];
  if (typeof methodFn !== "function") {
    return Response.json(
      { error: { message: `Method ${method} not allowed`, type: "invalid_request" } },
      { status: 405, headers: { Allow: getAllowHeader(handler as Record<string, unknown>) } }
    );
  }

  const context: RouteContext = {
    params: match.params,
    searchParams: url.searchParams,
  };

  // Pass the signal through to the handler for abort support
  if (signal) {
    try {
      Object.defineProperty(req, "signal", { value: signal, writable: false });
    } catch {
      // signal already set — ok
    }
  }

  return await (methodFn as (req: Request, ctx: RouteContext) => Promise<Response> | Response)(
    req,
    context
  );
}

// ── Server startup ─────────────────────────────────────────────────────────

export async function startBunServer(
  options: {
    port?: number;
    hostname?: string;
    preloadPaths?: string[];
  } = {}
): Promise<void> {
  const port = options.port ?? Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 20128);
  const hostname = options.hostname ?? process.env.HOST ?? "0.0.0.0";

  console.log("[bun] Discovering API routes...");
  const routes = discoverCoreRoutes();

  if (options.preloadPaths && options.preloadPaths.length > 0) {
    console.log(`[bun] Preloading ${options.preloadPaths.length} hot-path routes...`);
    await preloadRoutes(routes, options.preloadPaths);
    console.log("[bun] Hot-path routes preloaded");
  }

  const server = Bun.serve({
    port,
    hostname,
    // Max request body size — Bun supports this natively
    maxRequestBodySize: MAX_BODY_BYTES,

    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Health check — bypass semaphore
      if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/health") {
        return Response.json({
          status: "ok",
          mode: "bun-headless",
          inFlight,
          queued: requestQueue.length,
          internalInFlight,
          internalQueued: internalQueue.length,
          maxConcurrent: MAX_CONCURRENT_REQUESTS,
          queueDepthCap: MAX_QUEUE_DEPTH,
          queueWaitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS,
        });
      }

      // Reject oversized bodies early
      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > MAX_BODY_BYTES) {
        return Response.json(
          {
            error: {
              message: `Request body too large (${contentLength} bytes, max ${MAX_BODY_BYTES})`,
              type: "invalid_request",
            },
          },
          { status: 413 }
        );
      }

      const internal = isInternalRequest(req);
      const controller = new AbortController();

      try {
        await acquireSlot(internal, controller.signal);
        try {
          return await handleRequest(req, routes, controller.signal);
        } finally {
          releaseSlot(internal);
        }
      } catch (error) {
        if (error instanceof QueueRejectedError) {
          console.warn(`[bun] ${error.message}`);
          return Response.json(
            {
              error: {
                message: error.message,
                type: "server_error",
                code: `queue_${error.reason}`,
              },
            },
            { status: 503, headers: { "Retry-After": "5" } }
          );
        }
        console.error("[bun] Unhandled error:", error);
        return Response.json(
          { error: { message: "Internal server error", type: "server_error" } },
          { status: 500 }
        );
      }
    },

    // WebSocket support — Bun handles upgrades natively
    websocket: {
      open(ws) {
        // WS bridge handles this — delegate
        ws.data?.onOpen?.(ws);
      },
      message(ws, message) {
        ws.data?.onMessage?.(ws, message);
      },
      close(ws, code, reason) {
        ws.data?.onClose?.(ws, code, reason);
      },
    },
  });

  console.log(`[bun] Headless server listening on http://${hostname}:${port}`);
  console.log(`[bun] RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[bun] SIGTERM — shutting down");
    server.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("[bun] SIGINT — shutting down");
    server.stop();
    process.exit(0);
  });
}

// ── CLI entry point ────────────────────────────────────────────────────────

// Auto-start when run directly (not imported)
if (import.meta.main) {
  // Parse CLI args
  const args = process.argv.slice(2);
  let port: number | undefined;
  let hostname: string | undefined;
  const preloadPaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      hostname = args[i + 1];
      i++;
    } else if (args[i] === "--preload" && args[i + 1]) {
      preloadPaths.push(...args[i + 1].split(",").map((s) => s.trim()));
      i++;
    }
  }

  // Default preload paths — same as run-headless.mjs
  if (preloadPaths.length === 0) {
    preloadPaths.push(
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/embeddings",
      "/v1/models",
      "/v1/responses",
      "/api/monitoring/health"
    );
  }

  startBunServer({ port, hostname, preloadPaths }).catch((err) => {
    console.error("[bun] Fatal:", err);
    process.exit(1);
  });
}
