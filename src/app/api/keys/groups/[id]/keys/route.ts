import { z } from "zod";
import { addKeyToGroup, removeKeyFromGroup, getGroupMembers, getKeyGroup } from "@/lib/localDb";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type RouteParams = { params: Promise<{ id: string }> };

const addKeyToGroupSchema = z.object({
  keyId: z.string().trim().min(1, "keyId is required"),
});

/**
 * GET /api/keys/groups/[id]/keys — List API keys in a group
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const group = getKeyGroup(id);
    if (!group) return Response.json({ error: "Group not found" }, { status: 404 });
    const members = getGroupMembers(id);
    return Response.json({ members });
  } catch (error) {
    return Response.json({ error: "Failed to list members" }, { status: 500 });
  }
}

/**
 * POST /api/keys/groups/[id]/keys — Add an API key to the group
 * Body: { keyId }
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const group = getKeyGroup(id);
    if (!group) return Response.json({ error: "Group not found" }, { status: 404 });

    const rawBody = await request.json();
    const validation = validateBody(addKeyToGroupSchema, rawBody);
    if (isValidationFailure(validation)) {
      return Response.json({ error: validation.error }, { status: 400 });
    }
    const added = addKeyToGroup(validation.data.keyId, id);
    if (!added) {
      return Response.json({ error: "Failed to add key" }, { status: 500 });
    }
    return Response.json({ success: true }, { status: 201 });
  } catch (error) {
    return Response.json({ error: "Failed to add key to group" }, { status: 500 });
  }
}

/**
 * DELETE /api/keys/groups/[id]/keys?keyId=xxx — Remove an API key from the group
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const keyId = url.searchParams.get("keyId");
    if (!keyId) {
      return Response.json({ error: "keyId query param required" }, { status: 400 });
    }
    const removed = removeKeyFromGroup(keyId, id);
    if (!removed) {
      return Response.json({ error: "Key not found in group" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: "Failed to remove key from group" }, { status: 500 });
  }
}
