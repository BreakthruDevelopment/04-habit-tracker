import { requireUser } from "@/lib/auth/session";
import { CoachLimitError, coachRequestSchema, generateCoach, getCoach } from "@/lib/coach";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
// The model call can take up to AI_TIMEOUT_MS (20 s); keep the route open a little longer.
export const maxDuration = 25;

/** GET /api/coach?week=YYYY-Www (default this week; this or last week only): the stored summary or `summary: null`. Never calls the model. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return Response.json(await getCoach(user, new URL(request.url).searchParams.get("week") || null));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/coach `{ week? }`: generate or refresh the summary. 200 with `cached: true` when nothing changed (no model call).
 * 429 `{ error, reason, ...view }` when a cap is reached; the stored summary comes back with it.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const body = coachRequestSchema.parse(await readJson(request));
    return Response.json(await generateCoach(user, body.week || null));
  } catch (err) {
    if (err instanceof CoachLimitError) {
      return Response.json({ error: err.message, reason: err.reason, week: err.view?.week ?? null, summary: err.view?.summary ?? null, refreshesLeft: err.view?.refreshesLeft ?? 0 }, { status: 429 });
    }
    return errorResponse(err);
  }
}
