import { jwtVerify } from "jose";

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

function getCookieFromHeaders(headers: Headers | undefined, name: string): string | null {
  const cookieHeader = headers?.get("cookie") || headers?.get("Cookie");
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() !== name) continue;
    return rawValue.join("=").trim() || null;
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const token = getCookieFromHeaders(request.headers, "auth_token");
    const secret = getJwtSecret();

    if (!token || !secret) {
      return Response.json({ authenticated: false });
    }

    await jwtVerify(token, secret);
    return Response.json({ authenticated: true });
  } catch {
    return Response.json({ authenticated: false });
  }
}
