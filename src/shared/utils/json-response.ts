/**
 * Framework-agnostic JSON response helper.
 *
 * Drop-in replacement for `NextResponse.json()` — same signature, same behavior.
 * Routes that previously imported `NextResponse` from `next/server` can switch to
 * this with zero behavior change. Used by the headless server to avoid pulling in
 * the Next.js runtime for API-only deployments.
 *
 * @example
 * // Before:
 * import { NextResponse } from "next/server";
 * return NextResponse.json({ error: "Not found" }, { status: 404 });
 *
 * // After:
 * import { json } from "@/shared/utils/json-response";
 * return json({ error: "Not found" }, { status: 404 });
 */
export function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * Framework-agnostic redirect helper — mirrors `NextResponse.redirect()`.
 */
export function redirect(url: string | URL, init?: ResponseInit): Response {
  const status = init?.status ?? 307;
  const headers = new Headers(init?.headers);
  headers.set("Location", typeof url === "string" ? url : url.toString());
  return new Response(null, { ...init, status, headers });
}

/**
 * Framework-agnostic `NextResponse.rewrite()` equivalent.
 * In the headless server this is a no-op pass-through (no upstream proxy layer).
 */
export function rewrite(url: string | URL): Response {
  return new Response(null, { status: 200 });
}
