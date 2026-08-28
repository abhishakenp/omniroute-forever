/**
 * Route tier manifest — declarative route classification for headless mode.
 *
 * Replaces the hardcoded whitelist in server-bun.ts. Routes are classified
 * into tiers by directory pattern. The headless server loads only `core`
 * routes; the Next.js dev server loads all routes regardless of tier.
 *
 * ## Tiers
 *
 * - `core`    — required for the proxy to function (chat, models, providers,
 *               combos, keys, health, auth, resilience). Loaded in headless.
 * - `dashboard` — management UI, settings, analytics, tools. Not loaded in
 *               headless; available via Next.js dev server.
 * - `optional` — everything else. Not loaded in headless.
 *
 * ## How it works
 *
 * Each entry is a directory prefix relative to `src/app/api/`. Routes whose
 * path starts with a `core` prefix are loaded. Slash-terminated prefixes
 * match all sub-routes; non-slash prefixes match the exact path only.
 *
 * ## Adding a new core route
 *
 * If the route lives in an already-`core` directory (e.g. `v1/chat/`), it's
 * automatically included — no manifest change needed.
 *
 * If the route is in a new directory, add the directory to `CORE_DIRS` below.
 *
 * ## Adding a per-route override
 *
 * A route.ts file can export `routeTier` to override its directory-based tier:
 *   export const routeTier = "core";
 * This is checked by the discovery function via a fast regex scan (no import).
 */

export type RouteTier = "core" | "dashboard" | "optional";

/**
 * Directory prefixes (relative to /api/) that are core by default.
 * New routes in these directories are automatically included in headless mode.
 */
export const CORE_DIRS: string[] = [
  // Chat routing — the core proxy function
  "v1/chat/completions",
  "v1/messages",
  "v1/completions",
  "v1/responses",
  "v1/embeddings",
  "v1/moderations",
  "v1/rerank",
  "v1/audio/",
  "v1/images/",
  "v1/files",
  "v1/models",
  "v1/models/",
  "v1/combos",
  "v1/quotas/check",
  "v1/me/status",
  "v1/registered-keys",
  "v1/ws",
  "v1/providers/",
  // Provider connection management (provisioner adds/removes keys)
  "providers",
  // Combos = presets (omni/code-free, omni/review-free, etc)
  "combos",
  // API keys
  "keys",
  // Health + monitoring
  "monitoring",
  "health",
  "health/",
  // Synced models catalog + free-tier info
  "synced-available-models",
  "free-models",
  "free-tier",
  "free-provider-rankings",
  // Resilience / circuit breaker
  "resilience",
  // Auth (login/logout for dashboard access)
  "auth/status",
  "auth/login",
  "auth/logout",
];

/**
 * Dashboard-only directory prefixes. Listed for documentation; the headless
 * server simply loads anything not in CORE_DIRS as non-core.
 */
export const DASHBOARD_DIRS: string[] = [
  "settings/",
  "tools/",
  "cli-tools/",
  "gamification/",
  "skills/",
  "tunnels/",
  "vnc-session/",
  "compression/",
  "evals/",
  "playground/",
  "memory/",
  "version-manager/",
  "telegram/",
  "services/",
  "agent-skills/",
  "github-skills/",
  "plugins/",
];

/**
 * Classify a route path (e.g. "/api/v1/chat/completions") into a tier.
 * Uses directory-based rules + optional per-route override.
 */
export function classifyRoute(routePath: string, routeTierOverride?: RouteTier): RouteTier {
  if (routeTierOverride) return routeTierOverride;

  // Strip /api/ prefix for directory matching
  const rel = routePath.startsWith("/api/") ? routePath.slice(5) : routePath;

  for (const dir of CORE_DIRS) {
    if (dir.endsWith("/")) {
      if (rel.startsWith(dir)) return "core";
    } else {
      if (rel === dir || rel.startsWith(dir + "/")) return "core";
    }
  }

  for (const dir of DASHBOARD_DIRS) {
    if (dir.endsWith("/")) {
      if (rel.startsWith(dir)) return "dashboard";
    } else {
      if (rel === dir || rel.startsWith(dir + "/")) return "dashboard";
    }
  }

  return "optional";
}

/**
 * Fast regex scan of a route.ts file for `export const routeTier = "..."`.
 * Avoids importing the module — just reads the file content.
 */
export function scanRouteTier(modulePath: string): RouteTier | undefined {
  try {
    // Bun/Node: read first 2000 chars — the export is at the top of the file
    const content = Bun.file(modulePath);
    // Synchronous check for Bun; fallback for Node
    if (content.size === 0) return undefined;
    // Use text() for Bun, or readFileSync for Node
    const text =
      typeof Bun !== "undefined"
        ? require("fs").readFileSync(modulePath, "utf8")
        : require("fs").readFileSync(modulePath, "utf8");
    const match = text.match(/export\s+const\s+routeTier\s*=\s*["'](\w+)["']/);
    if (match) {
      const tier = match[1] as RouteTier;
      if (tier === "core" || tier === "dashboard" || tier === "optional") return tier;
    }
  } catch {
    // File read failed — no override
  }
  return undefined;
}
