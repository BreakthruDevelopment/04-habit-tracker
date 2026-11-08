import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { heatmap } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/progress/heatmap[?habitId=&days=30]: the last 30 days, across habits or for one of the caller's own. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = new URL(request.url).searchParams;
    return Response.json(await heatmap(user, { habitId: p.get("habitId"), days: p.get("days") || undefined }));
  } catch (err) {
    return errorResponse(err);
  }
}
