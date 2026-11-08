import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { habitProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/habits/:id/progress: streaks, 8-week goal hit rate and the editable days. Owner only (404 otherwise). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await habitProgress(user, id));
  } catch (err) {
    return errorResponse(err);
  }
}
