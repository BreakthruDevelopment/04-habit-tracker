import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { weekSummary } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/progress/week?week=YYYY-Www (ISO week-year; default this week). 400 for a week that doesn't exist or is out of range. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return Response.json(await weekSummary(user, new URL(request.url).searchParams.get("week") || null));
  } catch (err) {
    return errorResponse(err);
  }
}
