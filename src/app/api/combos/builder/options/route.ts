import { getComboBuilderOptions } from "@/lib/combos/builderOptions";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const options = await getComboBuilderOptions();
    return Response.json(options);
  } catch (error) {
    console.log("Error fetching combo builder options:", error);
    return Response.json({ error: "Failed to fetch combo builder options" }, { status: 500 });
  }
}
