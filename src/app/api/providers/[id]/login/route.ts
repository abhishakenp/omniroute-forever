/**
 * POST /api/providers/[id]/login
 *
 * Web-cookie provider login endpoint. Launches a browser,
 * navigates to the provider's login page, polls for session tokens,
 * and persists extracted credentials to the provider connection.
 */

import { getCachedProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const ADOBE_FIREFLY_SLUGS = new Set(["adobe-firefly", "firefly"]);

/** Resolve the provider slug (e.g. "claude-web", "adobe-firefly") from the connection row. */
function resolveProviderSlug(connection: Record<string, unknown> | null): string {
  const raw = connection?.provider;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "";
}

function isAdobeFireflyProvider(
  connection: { provider?: unknown } | null,
  providerSlug: string
): boolean {
  const raw = String(connection?.provider || "").trim();
  return ADOBE_FIREFLY_SLUGS.has(raw) || ADOBE_FIREFLY_SLUGS.has(providerSlug);
}

/**
 * Persist JWT + Cookie the way desktop clients (and generate) expect:
 * multi-line api_key, plus camelCase providerSpecificData for updateProviderConnection.
 */
async function persistAdobeFireflyCredentials(
  connectionId: string,
  opts: {
    accessToken?: string;
    cookie?: string;
    account?: string;
    arpSessionId?: string;
  }
): Promise<{
  accessToken: string;
  cookie: string;
  credential: string;
  account: string;
}> {
  const accessToken = String(opts.accessToken || "").trim();
  const cookie = String(opts.cookie || "").trim();
  const account = String(opts.account || "").trim();
  const credential =
    accessToken && cookie
      ? `${accessToken}\n${cookie}`
      : accessToken ||
        cookie ||
        JSON.stringify({
          mode: "browser-profile",
          account,
          signedInAt: Date.now(),
        });

  const marker = {
    mode: "browser-profile",
    account,
    signedInAt: Date.now(),
    arpSessionId: String(opts.arpSessionId || ""),
  };

  try {
    // camelCase only — updateProviderConnection / encryptConnectionFields read apiKey +
    // providerSpecificData (snake_case keys are silently ignored and never persisted).
    await updateProviderConnection(connectionId, {
      apiKey: credential,
      providerSpecificData: {
        ...marker,
        cookie: cookie || credential,
        access_token: accessToken || undefined,
      },
    });
  } catch {
    /* non-fatal — return credentials to the host app either way */
  }

  return { accessToken, cookie, credential, account };
}

function adobeFireflySuccessResponse(data: {
  accessToken: string;
  cookie: string;
  credential: string;
  account: string;
  arpSessionId?: string;
  via: "pure-cdp";
}): NextResponse {
  return Response.json({
    success: true,
    account: data.account || undefined,
    accessToken: data.accessToken || undefined,
    cookie: data.cookie || undefined,
    arpSessionId: data.arpSessionId || undefined,
    credential: data.credential,
    credentials: {
      access_token: data.accessToken || undefined,
      cookie: data.cookie || undefined,
    },
    via: data.via,
    persisted: true,
  });
}

/**
 * Adobe Firefly browser sign-in:
 * pure system Chrome/Edge CDP only (packaged-safe, no Playwright/browser bundle).
 */
async function loginAdobeFirefly(
  _connectionId: string,
  _body: { timeout?: unknown; freshSession?: unknown }
): Promise<NextResponse> {
  // Browser-based Adobe Firefly login removed for thin API gateway.
  return Response.json(
    {
      success: false,
      error: "Adobe Firefly browser login is not available (browser executor removed)",
    },
    { status: 503 }
  );
}

// --- POST: Start login flow -------------------------------------------------

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await requireManagementAuth(req);
  if (auth) return auth;

  const { id } = await params;
  const provider = await getCachedProviderConnectionById(id);
  if (!provider) {
    return Response.json({ success: false, error: "Provider not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    timeout?: unknown;
    freshSession?: unknown;
  };
  const providerSlug = resolveProviderSlug(provider as Record<string, unknown>);

  // Adobe Firefly: dedicated JWT capture (never cookies/localStorage alone).
  if (isAdobeFireflyProvider(provider as { provider?: unknown }, providerSlug)) {
    try {
      return await loginAdobeFirefly(id, body);
    } catch (err) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
      return Response.json(
        { success: false, error: `Adobe Firefly sign-in error: ${msg}` },
        { status: 500 }
      );
    }
  }

  try {
    // Browser-based in-app login removed for thin API gateway.
    return Response.json(
      {
        success: false,
        error: "Browser-based login is not available (browser executor removed)",
      },
      { status: 503 }
    );
  } catch (err) {
    // Hard Rule #12: never put raw err.message/stack in a response body.
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return Response.json(
      { success: false, error: `Login endpoint error: ${msg}` },
      { status: 500 }
    );
  }
}
