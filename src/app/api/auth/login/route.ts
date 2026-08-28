import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { classifyIpScope } from "@/lib/ipUtils";
import { getCachedSettings } from "@/lib/localDb";
import { SignJWT } from "jose";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { loginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";

// SECURITY: No hardcoded fallback — JWT_SECRET must be configured.
if (!process.env.JWT_SECRET) {
  console.error("[SECURITY] FATAL: JWT_SECRET is not set. Login authentication is disabled.");
}

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET || "");
}

// Test seam for cookie store injection without affecting runtime behavior.
export const authRouteInternals = {
  getCookieStore: null as null | (() => Promise<{ set: (name: string, value: string, opts: Record<string, unknown>) => void; delete: (name: string, opts?: Record<string, unknown>) => void }>),
};

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);

  try {
    // Fail-fast if JWT_SECRET is not configured
    if (!process.env.JWT_SECRET) {
      logAuditEvent({
        action: "auth.login.misconfigured",
        actor: "system",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_jwt_secret" },
      });
      return Response.json(
        { error: "Server misconfigured: JWT_SECRET not set. Contact administrator." },
        { status: 500 }
      );
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "body", message: "Invalid JSON body" }],
          },
        },
        { status: 400 }
      );
    }

    // Zod validation
    const validation = validateBody(loginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const password = typeof validation.data.password === "string" ? validation.data.password : "";
    if (!password) {
      return Response.json({ error: "Invalid password payload" }, { status: 400 });
    }
    const settings = await getCachedSettings();
    const bruteForceEnabled = settings.bruteForceProtection !== false;
    const clientIp = auditContext.ipAddress || null;

    const guardCheck = checkLoginGuard(clientIp, { enabled: bruteForceEnabled });
    if (!guardCheck.allowed) {
      logAuditEvent({
        action: "auth.login.locked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: clientIp || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guardCheck.retryAfterSeconds || 0 },
      });
      return Response.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: guardCheck.retryAfterSeconds
            ? { "Retry-After": String(guardCheck.retryAfterSeconds) }
            : {},
        }
      );
    }

    const passwordState = await ensurePersistentManagementPasswordHash({
      settings,
      source: "auth.login",
    });
    const storedHash = getStoredManagementPassword(passwordState.settings);

    if (!storedHash) {
      logAuditEvent({
        action: "auth.login.setup_required",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_persisted_password" },
      });
      return Response.json(
        { error: "No password configured. Complete onboarding first.", needsSetup: true },
        { status: 403 }
      );
    }

    const isValid = await verifyManagementPassword(password, storedHash);

    if (isValid) {
      const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
      const forwardedProtoHeader = request.headers.get("x-forwarded-proto") || "";
      const forwardedProto = forwardedProtoHeader.split(",")[0].trim().toLowerCase();
      const isHttpsRequest = forwardedProto === "https:" || new URL(request.url).protocol === "https:";
      const useSecureCookie = forceSecureCookie || isHttpsRequest;

      const token = await new SignJWT({ authenticated: true })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("30d")
        .sign(getJwtSecret());

      const cookieParts = [
        `auth_token=${token}`,
        "HttpOnly",
        `SameSite=Lax`,
        "Path=/",
        `Max-Age=${60 * 60 * 24 * 30}`,
      ];
      if (useSecureCookie) cookieParts.push("Secure");
      const setCookieHeader = cookieParts.join("; ");

      logAuditEvent({
        action: "auth.login.success",
        actor: "admin",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "success",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          hasStoredPassword: Boolean(storedHash),
          passwordMigrated: passwordState.migrated,
          secureCookie: useSecureCookie,
        },
      });

      clearLoginAttempts(clientIp);
      return Response.json({ success: true }, { status: 200, headers: { "Set-Cookie": setCookieHeader } });
    }

    const failureDecision = recordLoginFailure(clientIp, { enabled: bruteForceEnabled });

    // #8336: tag the origin scope so the audit view can distinguish a mistyped
    // password from the host itself / the LAN (loopback / private) from a
    // genuinely external attempt, instead of every failure reading as intrusion.
    const sourceScope = classifyIpScope(auditContext.ipAddress);

    logAuditEvent({
      action: "auth.login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        reason: "invalid_password",
        lockedOut: failureDecision.allowed === false,
        sourceScope,
        internalOrigin: sourceScope === "loopback" || sourceScope === "private",
      },
    });

    if (!failureDecision.allowed) {
      return Response.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: failureDecision.retryAfterSeconds
            ? { "Retry-After": String(failureDecision.retryAfterSeconds) }
            : {},
        }
      );
    }

    return Response.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    console.error("[AUTH] Login failed:", error);
    logAuditEvent({
      action: "auth.login.error",
      actor: "system",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        message: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
