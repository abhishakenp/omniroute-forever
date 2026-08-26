#!/usr/bin/env node

/**
 * Headless API server entry point.
 *
 * Runs OmniRoute's API without Next.js — no turbopack, no SST cache, no
 * compilation overhead. Designed for VPS / background / headless deployments
 * where only the LLM proxy API is needed.
 *
 * Usage:
 *   node --import tsx/esm scripts/dev/run-headless.mjs
 *   node --import tsx/esm scripts/dev/run-headless.mjs --port 20128
 *
 * Environment:
 *   PORT / DASHBOARD_PORT — listen port (default 20128)
 *   HOST — bind address (default 0.0.0.0)
 *   DATA_DIR — OmniRoute data directory
 *   OMNIROUTE_HEADLESS_PRELOAD — comma-separated route paths to preload
 */

// Register tsx for .ts imports (same as bin/omniroute.mjs)
await import("tsx/esm");
await import("../../open-sse/utils/setupPolyfill.ts");

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { resolveRuntimePorts, withRuntimePortEnv } from "../build/runtime-env.mjs";
import { ensurePeerStampToken } from "./peer-stamp.mjs";
import { ensureNativeSqlite } from "./ensure-native-sqlite.mjs";
import { getMainServerTimeoutConfig } from "./main-server-timeouts.mjs";

// Pre-read DATA_DIR from local .env before bootstrap resolves paths
if (!process.env.DATA_DIR) {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const match = raw.match(/^DATA_DIR=(.+)$/m);
    if (match?.[1]?.trim()) process.env.DATA_DIR = match[1].trim();
  } catch {
    /* .env absent — ok, bootstrap uses the default */
  }
}

// Self-heal stale better-sqlite3 native binary after a Node version switch
ensureNativeSqlite();

const bootstrappedEnv = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(bootstrappedEnv);
const mergedEnv = withRuntimePortEnv(bootstrappedEnv, runtimePorts);

for (const [key, value] of Object.entries(mergedEnv)) {
  if (value !== undefined) {
    process.env[key] = value;
  }
}

// Headless mode is always "production" for NODE_ENV — no dev compilation
process.env.NODE_ENV = "production";
process.env.OMNIROUTE_INTERNAL_SCHEME = "http";
process.env.OMNIROUTE_HEADLESS = "1";
process.env.OMNIROUTE_WS_BRIDGE_SECRET ||= randomUUID();
ensurePeerStampToken();

const { dashboardPort } = runtimePorts;
const hostname = process.env.HOST || "0.0.0.0";

// Memory guard — set above the V8 heap limit to catch leaks before OOM.
// With 2048 MB heap + overhead, 3072 MB is the safety net.
const MEM_LIMIT_MB = Number(process.env.OMNIROUTE_HEADLESS_MEM_LIMIT_MB || 3072);
let shuttingDown = false;

function checkMemory() {
  if (shuttingDown) return;
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);

  if (rssMB > MEM_LIMIT_MB) {
    console.warn(
      `[headless] Memory limit exceeded: ${rssMB}MB > ${MEM_LIMIT_MB}MB — graceful shutdown`
    );
    shuttingDown = true;
    gracefulShutdown("MEMORY_LIMIT");
  }
}

setInterval(checkMemory, 5_000);

// Log rotation — prevent unbounded log growth (matches enable.mjs settings)
function rotateLogOnStartup() {
  try {
    const logDir = path.join(
      process.env.DATA_DIR || path.join(process.env.HOME || "", ".omniroute"),
      "logs"
    );
    const logFile = path.join(logDir, "omniroute.log");
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    if (stat.size < 10 * 1024 * 1024) return; // 10 MB
    for (let i = 5; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (fs.existsSync(src)) {
        if (i + 1 > 5) fs.unlinkSync(src);
        else fs.renameSync(src, `${logFile}.${i + 1}`);
      }
    }
    fs.renameSync(logFile, `${logFile}.1`);
    console.log(`[headless] Rotated log file (was ${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch {
    // best-effort
  }
}

rotateLogOnStartup();

// Start the server
async function start() {
  const { startHeadlessServer } = await import("../../src/server/headless/server.ts");

  // Determine preload paths from env or defaults
  const defaultPreload = [
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/messages",
    "/v1/completions",
    "/v1/responses",
    "/v1/models",
  ];
  const preloadPaths = process.env.OMNIROUTE_HEADLESS_PRELOAD
    ? process.env.OMNIROUTE_HEADLESS_PRELOAD.split(",").map((s) => s.trim())
    : defaultPreload;

  const server = await startHeadlessServer({
    port: dashboardPort,
    hostname,
    preloadPaths,
  });

  // Start background schedulers (same as run-next.mjs)
  await startBackgroundSchedulers();

  // Graceful shutdown
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[headless] ${signal} received — shutting down...`);
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function gracefulShutdown(reason) {
  console.log(`[headless] Graceful shutdown: ${reason}`);
  process.exit(0);
}

/**
 * Start background schedulers by reusing the existing instrumentation-node.ts
 * bootstrap — same code path as Next.js, ensuring parity with the dev server.
 */
async function startBackgroundSchedulers() {
  try {
    const { registerNodejs } = await import("../../src/instrumentation-node.ts");
    await registerNodejs();
    console.log("[STARTUP] Instrumentation-node bootstrap complete");
  } catch (e) {
    console.warn("[STARTUP] Instrumentation-node bootstrap failed:", e?.message);
    // Fall back to manual DB init
    try {
      const { getDbInstance } = await import("../../src/lib/db/core.ts");
      getDbInstance();
      console.log("[DB] SQLite database ready (fallback)");
    } catch (e2) {
      console.warn("[DB] Database init failed:", e2?.message);
    }
  }

  try {
    // Live WS daemon (for dashboard connections — no-op in headless but safe to start)
    const { bootstrapLiveWsDaemon } = await import("../../src/server/ws/liveServer.ts");
    bootstrapLiveWsDaemon?.();
    console.log("[STARTUP] Live dashboard WebSocket daemon bootstrap invoked");
  } catch (e) {
    console.warn("[STARTUP] Live WS daemon failed:", e?.message);
  }

  console.log("[STARTUP] Headless server bootstrap complete");
}

// Boot
start().catch((error) => {
  console.error("[FATAL] Headless server failed to start:", error);
  process.exit(1);
});
