/**
 * The core API routes both hosts serve — `server-elysia.ts` and the Cordis
 * gateway row (`packages/omniroute-gateway`).
 *
 * Extracted from `server-elysia.ts` unchanged so the two cannot drift. The
 * gateway row once served only `/health`, `/v1/models` and chat on the belief
 * that everything under `src/app/api/` was dashboard; it is not. The account
 * provisioner (`~/proj/account-provisioner/src/core/omniroute-client.ts`) adds,
 * updates and removes connections through `/api/providers`, and
 * `provisionerHook.ts` polls the same route — a host without it quietly stops
 * provisioning, which is the one thing OmniRoute exists for.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface RouteHandler {
  GET?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  POST?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  PUT?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  DELETE?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  PATCH?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  OPTIONS?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
  HEAD?: (req: Request, ctx: RouteContext) => Promise<Response> | Response;
}

export interface RouteContext {
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
}

type Segment =
  | { type: "literal"; value: string }
  | { type: "param"; name: string }
  | { type: "catch-all"; name: string }
  | { type: "optional-catch-all"; name: string };

export interface CompiledRoute {
  originalPath: string;
  segments: Segment[];
  modulePath: string;
  specificity: number;
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const;

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

/** `src/app/api` under a repo root. */
export const apiDirFor = (root: string): string => join(root, "src", "app", "api");

export function discoverRoutes(apiDir: string): CompiledRoute[] {
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

export function matchRoute(path: string, routes: CompiledRoute[]) {
  const pathSegments = path.split("/").filter(Boolean);
  for (const route of routes) {
    const params = tryMatch(pathSegments, route.segments);
    if (params !== null) return { route, params };
  }
  return null;
}

const moduleCache = new Map<string, RouteHandler>();

export async function loadRouteHandler(route: CompiledRoute): Promise<RouteHandler> {
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
