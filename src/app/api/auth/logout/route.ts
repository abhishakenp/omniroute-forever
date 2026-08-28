import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";

export async function POST(request: Request) {
  const auditContext = getAuditRequestContext(request);
  logAuditEvent({
    action: "auth.logout.success",
    actor: "admin",
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
  });
  return Response.json(
    { success: true },
    { status: 200, headers: { "Set-Cookie": "auth_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" } }
  );
}
