/**
 * Headless HTTP server — serves OmniRoute API routes without Next.js.
 *
 * Replaces the Next.js dev server for API-only deployments (VPS, background,
 * headless mode). No turbopack, no SST cache, no compilation overhead.
 *
 * Route handlers are auto-discovered from `src/app/api/` and lazy-loaded on
 * first request. The server uses Node's built-in `http` module with WebSocket
 * upgrade support (reuses existing standalone-server-ws.mjs).
 */

import http from "node:http";
import { URL } from "node:url";
import {
  discoverRoutes,
  matchRoute,
  loadRouteHandler,
  preloadRoutes,
  type RouteContext,
  type CompiledRoute,
} from "./router.ts";

/**
 * Two-tier concurrency semaphore.
 *
 * Client requests (external API calls from pi, provisioner, etc.) get
 * MAX_CONCURRENT_REQUESTS slots. Internal self-fetches (ModelSync,
 * DYNAMIC_FREE_COMBO, CredentialHealth) get MAX_CONCURRENT_INTERNAL slots.
 *
 * Without this split, 86 ModelSync + 256 DYNAMIC_FREE_COMBO self-fetches
 * saturate all client slots, and external requests queue indefinitely —
 * which is what caused the OmniRoute wedge (queued: 264, /api/providers
 * timing out at 20s, provisioner isAlive() returning false).
 *
 * Internal requests are identified by the `x-model-sync-internal-auth`
 * header (set by modelSyncScheduler and dynamicFreeCombo self-fetches).
 */
const MAX_CONCURRENT_REQUESTS = Number(process.env.OMNIROUTE_MAX_CONCURRENT || 8);
const MAX_CONCURRENT_INTERNAL = Number(process.env.OMNIROUTE_MAX_CONCURRENT_INTERNAL || 8);
/**
 * Max requests allowed to WAIT for a slot. Beyond this, new arrivals are
 * rejected immediately with 503 instead of piling onto an ever-growing queue
 * (the mass-exhaustion wedge: queued grew unbounded while /health stayed 200).
 */
const MAX_QUEUE_DEPTH = Number(process.env.OMNIROUTE_MAX_QUEUE_DEPTH || 100);
/**
 * Server-side deadline (ms) a request may spend waiting in the queue. Without
 * this, clients that time out and disconnect leave their queue entries pinned
 * forever, so the queue never drains and slots never recycle.
 */
const QUEUE_WAIT_TIMEOUT_MS = Number(process.env.OMNIROUTE_QUEUE_TIMEOUT_MS || 30_000);
let inFlight = 0;
let internalInFlight = 0;

interface QueueEntry {
  /** Abandoned (timeout/disconnect) — releaseSlot must skip it. */
  cancelled: boolean;
  run(): void;
}
const requestQueue: QueueEntry[] = [];
const internalQueue: QueueEntry[] = [];

/** Rejected while waiting for a slot (queue full, deadline hit, or client gone). */
export class QueueRejectedError extends Error {
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
      if (settled) return; // already granted (slot handed out) or already rejected
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (granted) {
        if (isInternal) internalInFlight++;
        else inFlight++;
        resolve();
      } else {
        entry.cancelled = true; // releaseSlot skips us later
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
    // Pending queue waits must not delay process shutdown.
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(entry);
  });
}

function releaseSlot(isInternal: boolean): void {
  const idle = () => {
    if (inFlight === 0 && internalInFlight === 0 && typeof global.gc === "function") {
      // Idle GC — when no requests are in flight, do a full GC.
      global.gc();
    }
  };
  if (isInternal) internalInFlight--;
  else inFlight--;
  // Hand the freed slot to the next LIVE waiter, skipping entries abandoned by
  // queue-timeout or client disconnect (their promises are already rejected).
  const queue = isInternal ? internalQueue : requestQueue;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (!next.cancelled) {
      next.run(); // re-increments the in-flight counter
      return;
    }
  }
  idle();
}

/**
 * Detect internal self-fetches by checking for the model-sync internal auth
 * header. ModelSync sets this header; DYNAMIC_FREE_COMBO is patched to set it
 * too. This lets background tasks bypass the client concurrency limit.
 */
function isInternalRequest(req: http.IncomingMessage): boolean {
  return Boolean(req.headers["x-model-sync-internal-auth"]);
}

/** Max request body size (bytes). Rejects oversized payloads early. */
const MAX_BODY_BYTES = Number(process.env.OMNIROUTE_MAX_BODY_BYTES || 2 * 1024 * 1024); // 2 MB default

export interface HeadlessServerOptions {
  port?: number;
  hostname?: string;
  /** Routes to preload at startup (by path prefix, e.g. ["/v1/chat"]) */
  preloadPaths?: string[];
  /** Called after the server starts listening */
  onListen?: (port: number) => void;
}

/**
 * Create and start the headless API server.
 *
 * @returns The http.Server instance (for graceful shutdown)
 */
export async function startHeadlessServer(
  options: HeadlessServerOptions = {}
): Promise<http.Server> {
  const port = options.port ?? Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 20128);
  const hostname = options.hostname ?? process.env.HOST ?? "0.0.0.0";

  console.log("[headless] Discovering API routes...");
  const routes = discoverRoutes();
  console.log(`[headless] Found ${routes.length} API routes`);

  // Preload hot-path routes (chat completions, embeddings, messages)
  if (options.preloadPaths && options.preloadPaths.length > 0) {
    console.log(`[headless] Preloading ${options.preloadPaths.length} hot-path routes...`);
    await preloadRoutes(routes, options.preloadPaths);
    console.log("[headless] Hot-path routes preloaded");
  }

  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Health check — bypass the semaphore so it always responds immediately,
    // even when all processing slots are busy with chat completions.
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mode: "headless",
          inFlight,
          queued: requestQueue.length,
          internalInFlight,
          internalQueued: internalQueue.length,
          maxConcurrent: MAX_CONCURRENT_REQUESTS,
          queueDepthCap: MAX_QUEUE_DEPTH,
          queueWaitTimeoutMs: QUEUE_WAIT_TIMEOUT_MS,
        })
      );
      return;
    }

    // Reject oversized bodies early (before parsing)
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Request body too large (${contentLength} bytes, max ${MAX_BODY_BYTES})`,
            type: "invalid_request",
          },
        })
      );
      return;
    }
    const internal = isInternalRequest(req);
    // Per-request lifecycle: if the client gives up (timeout/disconnect), abort
    // the in-flight handler and cancel its queued wait instead of wedging the
    // queue behind a dead request.
    const controller = new AbortController();
    const onConnectionClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onConnectionClosed);
    try {
      await acquireSlot(internal, controller.signal);
      try {
        await handleRequest(req, res, routes, controller.signal);
      } finally {
        releaseSlot(internal);
        res.off("close", onConnectionClosed);
      }
    } catch (error) {
      res.off("close", onConnectionClosed);
      if (error instanceof QueueRejectedError) {
        console.warn(`[headless] ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
          res.end(
            JSON.stringify({
              error: {
                message: error.message,
                type: "server_error",
                code: `queue_${error.reason}`,
              },
            })
          );
        }
      } else {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: "Internal server error", type: "server_error" } })
          );
        }
        console.error("[headless] Unhandled error:", error);
      }
    }
  });

  // WebSocket upgrade support — delegate to the existing WS bridge
  server.on("upgrade", async (req, socket, head) => {
    try {
      // Try importing the existing WS bridge modules
      const { createResponsesWsProxy } = await import("../../scripts/dev/responses-ws-proxy.mjs");
      const { createOmnirouteWsBridge } = await import("../../scripts/dev/v1-ws-bridge.mjs");
      const { ensurePeerStampToken, stampPeerIp } =
        await import("../../scripts/dev/peer-stamp.mjs");

      const dashboardPort = port;
      const responsesWsProxy = createResponsesWsProxy({
        baseUrl: `http://127.0.0.1:${dashboardPort}`,
        bridgeSecret: process.env.OMNIROUTE_WS_BRIDGE_SECRET,
      });
      const wsBridge = createOmnirouteWsBridge({
        baseUrl: `http://127.0.0.1:${dashboardPort}`,
      });

      stampPeerIp(req);
      const responsesHandled = await responsesWsProxy.handleUpgrade(req, socket, head);
      if (responsesHandled) return;
      const handled = await wsBridge.handleUpgrade(req, socket, head);
      if (handled) return;

      // No WS handler matched — close the socket
      socket.destroy();
    } catch (error) {
      console.error("[headless] WS upgrade failed:", error);
      if (!socket.destroyed) socket.destroy();
    }
  });

  // Keep-alive tuning (matches run-next.mjs settings)
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return new Promise((resolve, reject) => {
    server.listen(port, hostname, () => {
      console.log(`[headless] API server listening on http://${hostname}:${port}`);
      options.onListen?.(port);
      resolve(server);
    });
    server.on("error", reject);
  });
}

/**
 * Handle a single HTTP request: match route, load handler, invoke method.
 */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: CompiledRoute[],
  signal?: AbortSignal
): Promise<void> {
  const method = req.method?.toUpperCase() ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // Routes are registered with /api prefix (matching src/app/api/ structure).
  // Incoming paths may or may not have /api — normalize to /api/*.
  let routePath = path;
  if (!routePath.startsWith("/api/")) {
    routePath = "/api" + routePath;
  }

  // Match the route
  const match = matchRoute(routePath, routes);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
    return;
  }

  // Load the handler module (lazy)
  let handler;
  try {
    handler = await loadRouteHandler(match.route);
  } catch (error) {
    console.error(`[headless] Failed to load route ${match.route.originalPath}:`, error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: { message: "Route module load failed", type: "server_error" } })
    );
    return;
  }

  // Check if the method is supported
  const methodFn = handler[method as keyof typeof handler];
  if (typeof methodFn !== "function") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: getAllowHeader(handler) });
    res.end(
      JSON.stringify({
        error: { message: `Method ${method} not allowed`, type: "invalid_request" },
      })
    );
    return;
  }

  // Build a Web API Request from the Node.js IncomingMessage
  const request = await nodeRequestToWebRequest(req, url, match.params, signal);

  // Build the route context (matches Next.js { params } shape)
  const context: RouteContext = {
    params: match.params,
    searchParams: url.searchParams,
  };

  // Invoke the handler
  const response = await methodFn(request, context);

  // Write the Web API Response back to the Node.js ServerResponse
  await writeWebResponseToNodeResponse(response, res);
}

/**
 * Convert a Node.js IncomingMessage to a Web API Request.
 * Uses Node.js built-in Readable.toWeb() for proper stream conversion.
 */
async function nodeRequestToWebRequest(
  req: http.IncomingMessage,
  url: URL,
  params: Record<string, string | string[]>,
  signal?: AbortSignal
): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  // Use Node.js built-in Readable.toWeb() for proper stream conversion
  let body: ReadableStream<Uint8Array> | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const { Readable } = await import("node:stream");
    body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    body,
    // @ts-expect-error — duplex is needed for streaming bodies in Node
    duplex: "half",
  };

  // Abort signal combines (a) a request already aborted before we saw it and
  // (b) the server-side lifecycle signal — fired when the client disconnects
  // mid-handler so upstream fetches/SSE streams cancel and free the slot.
  let finalSignal = signal;
  if (req.aborted) {
    finalSignal = finalSignal
      ? AbortSignal.any([finalSignal, AbortSignal.abort()])
      : AbortSignal.abort();
  }
  if (finalSignal) {
    init.signal = finalSignal;
  }

  return new Request(url.toString(), init);
}

/**
 * Write a Web API Response back to a Node.js ServerResponse.
 * Handles streaming bodies (ReadableStream), headers, and status.
 */
async function writeWebResponseToNodeResponse(
  response: Response,
  res: http.ServerResponse
): Promise<void> {
  // Collect headers first, then writeHead with status + headers together
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of response.headers.entries()) {
    if (key in headers) {
      const existing = headers[key];
      headers[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      headers[key] = value;
    }
  }
  res.writeHead(response.status, response.statusText || undefined, headers);

  // Body
  if (!response.body) {
    res.end();
    return;
  }

  // Stream the body
  const reader = response.body.getReader();
  try {
    while (true) {
      // Client gone (socket destroyed): stop reading the upstream body and
      // return — otherwise a dead "drain" wait would pin this request's slot.
      if (res.destroyed) {
        reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        // Destroyed while the chunk read was pending: write() returned false
        // but no drain/close/error will ever fire afterwards, so park only
        // when the stream is still live; otherwise bail via the loop top.
        if (res.destroyed || res.writableEnded) continue;
        // Backpressure — wait for drain. A disconnected client never drains,
        // so also wake on close/error and let the destroyed check exit.
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("error", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
          res.once("error", done);
        });
      }
    }
    res.end();
  } catch (error) {
    reader.cancel().catch(() => {});
    if (!res.writableEnded) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function getAllowHeader(handler: Record<string, unknown>): string {
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].filter(
    (m) => typeof handler[m] === "function"
  );
  return methods.join(", ");
}
