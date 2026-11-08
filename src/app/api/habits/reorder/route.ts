import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { reorderHabits } from "@/lib/habits";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/habits/reorder. Body: { ids: [every active habit id, in the new order] }. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json({ habits: await reorderHabits(user, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
