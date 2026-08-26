/**
 * Headless route registry and matcher.
 *
 * Auto-discovers route handlers from `src/app/api/` by scanning for `route.ts` files,
 * converts Next.js dynamic segment syntax (`[param]`, `[...catchAll]`, `[[...slug]]`)
 * to internal route patterns, and matches incoming URLs to the correct handler.
 *
 * This replaces Next.js's App Router for headless / API-only deployments — no
 * turbopack, no SST cache, no compilation overhead.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RouteHandler {
  GET?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  POST?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  PUT?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  DELETE?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  PATCH?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  OPTIONS?: (request: Request, context: RouteContext) => Promise<Response> | Response;
  HEAD?: (request: Request, context: RouteContext) => Promise<Response> | Response;
}

export interface RouteContext {
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
}

interface CompiledRoute {
  /** Original Next.js path, e.g. `/v1/providers/[provider]/chat/completions` */
  originalPath: string;
  /** Segments: literal strings or `:param` or `:param*` (catch-all) */
  segments: Segment[];
  /** The module path to dynamically import */
  modulePath: string;
  /** Pre-computed specificity for sorting (more specific = higher) */
  specificity: number;
}

type Segment =
  | { type: "literal"; value: string }
  | { type: "param"; name: string }
  | { type: "catch-all"; name: string }
  | { type: "optional-catch-all"; name: string };

const API_DIR = join(process.cwd(), "src", "app", "api");
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const;

/**
 * Scan `src/app/api/` for `route.ts` files and build a compiled route table.
 * Routes are sorted by specificity (literal > param > catch-all) so the first
 * match wins, mirroring Next.js's route resolution order.
 */
export function discoverRoutes(apiDir: string = API_DIR): CompiledRoute[] {
  const routes: CompiledRoute[] = [];

  function scan(dir: string) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scan(fullPath);
      } else if (entry === "route.ts" || entry === "route.tsx") {
        const relativePath = relative(apiDir, fullPath);
        // Prepend /api — routes in src/app/api/ are served at /api/*
        const routePath =
          "/api/" +
          relativePath
            .replace(/\/route\.tsx?$/, "")
            .split(sep)
            .join("/");
        routes.push(compileRoute(routePath, fullPath));
      }
    }
  }

  scan(apiDir);

  // Sort by specificity: more literal segments first, catch-all last
  routes.sort((a, b) => b.specificity - a.specificity);
  return routes;
}

function compileRoute(routePath: string, modulePath: string): CompiledRoute {
  const rawSegments = routePath.split("/").filter(Boolean);
  const segments: Segment[] = [];
  let specificity = 0;

  for (const seg of rawSegments) {
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      const name = seg.slice(4, -1);
      segments.push({ type: "catch-all", name });
      specificity -= 10; // catch-all is least specific
    } else if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      const name = seg.slice(5, -2);
      segments.push({ type: "optional-catch-all", name });
      specificity -= 5;
    } else if (seg.startsWith("[") && seg.endsWith("]")) {
      const name = seg.slice(1, -1);
      segments.push({ type: "param", name });
      specificity += 1;
    } else {
      segments.push({ type: "literal", value: decodeSegment(seg) });
      specificity += 10;
    }
  }

  return { originalPath: routePath, segments, modulePath, specificity };
}

/**
 * Next.js encodes special characters in directory names. Decode them back.
 * e.g. `%5B...omnirouteCatchAll%5D` → `[...omnirouteCatchAll]` (already handled above),
 * but also handles encoded dots and other chars.
 */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Match a URL path against the compiled route table.
 * Returns the matched route and extracted params, or null.
 */
export function matchRoute(
  path: string,
  routes: CompiledRoute[]
): { route: CompiledRoute; params: Record<string, string | string[]> } | null {
  const pathSegments = path.split("/").filter(Boolean);

  for (const route of routes) {
    const params = tryMatch(pathSegments, route.segments);
    if (params !== null) {
      return { route, params };
    }
  }
  return null;
}

function tryMatch(
  pathSegments: string[],
  routeSegments: Segment[]
): Record<string, string | string[]> | null {
  const params: Record<string, string | string[]> = {};

  let pi = 0; // path index
  let ri = 0; // route index

  while (ri < routeSegments.length) {
    const seg = routeSegments[ri];

    if (seg.type === "literal") {
      if (pi >= pathSegments.length) return null;
      if (decodeURIComponent(pathSegments[pi]) !== seg.value) return null;
      pi++;
      ri++;
    } else if (seg.type === "param") {
      if (pi >= pathSegments.length) return null;
      params[seg.name] = decodeURIComponent(pathSegments[pi]);
      pi++;
      ri++;
    } else if (seg.type === "catch-all") {
      // [...param] — consumes all remaining segments (at least 0 for optional, 1+ for required)
      const remaining = pathSegments.slice(pi);
      if (remaining.length === 0) {
        // catch-all requires at least 0 segments (it's greedy)
        params[seg.name] = [];
      } else {
        params[seg.name] = remaining.map((s) => decodeURIComponent(s));
      }
      pi = pathSegments.length;
      ri++;
      // catch-all must be the last segment
      if (ri < routeSegments.length) return null;
    } else if (seg.type === "optional-catch-all") {
      // [[...param]] — consumes 0 or more remaining segments
      const remaining = pathSegments.slice(pi);
      params[seg.name] = remaining.map((s) => decodeURIComponent(s));
      pi = pathSegments.length;
      ri++;
      if (ri < routeSegments.length) return null;
    }
  }

  // All route segments consumed — path must also be fully consumed
  if (pi < pathSegments.length) return null;

  return params;
}

/**
 * Dynamic module cache: imported route modules keyed by module path.
 * Lazy-loaded on first request to each route.
 */
const moduleCache = new Map<string, RouteHandler>();

/**
 * Load a route handler module (lazy import with caching).
 * Uses dynamic `import()` so modules are only loaded when first requested.
 */
export async function loadRouteHandler(route: CompiledRoute): Promise<RouteHandler> {
  const cached = moduleCache.get(route.modulePath);
  if (cached) return cached;

  // Convert absolute path to file:// URL for dynamic import
  const fileUrl = `file://${route.modulePath}`;
  const mod = await import(fileUrl);
  const handler: RouteHandler = {};
  for (const method of HTTP_METHODS) {
    if (typeof mod[method] === "function") {
      handler[method] = mod[method];
    }
  }
  moduleCache.set(route.modulePath, handler);
  return handler;
}

/**
 * Preload specific route modules at startup (for hot paths).
 */
export async function preloadRoutes(routes: CompiledRoute[], paths: string[]): Promise<void> {
  const toPreload = routes.filter((r) =>
    paths.some((p) => r.originalPath === p || r.originalPath.startsWith(p + "/"))
  );
  await Promise.all(
    toPreload.map((r) =>
      loadRouteHandler(r).catch((err) => {
        console.warn(`[headless] Failed to preload ${r.originalPath}: ${err.message}`);
      })
    )
  );
}
