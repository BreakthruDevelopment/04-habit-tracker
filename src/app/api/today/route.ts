import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { today } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/today: active habits with today's value, done, streak and this week's dots (date from the user's stored zone). */
export async function GET() {
  try {
    return Response.json(await today(await requireUser()));
  } catch (err) {
    return errorResponse(err);
  }
}
