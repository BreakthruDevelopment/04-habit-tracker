import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { streaks } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/progress/streaks: { streaks: { [habitId]: { mode: "day"|"week", current, best } } } for active habits. */
export async function GET() {
  try {
    return Response.json({ streaks: await streaks(await requireUser()) });
  } catch (err) {
    return errorResponse(err);
  }
}
