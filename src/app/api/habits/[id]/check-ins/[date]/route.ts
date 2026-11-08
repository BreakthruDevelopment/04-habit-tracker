import { requireUser } from "@/lib/auth/session";
import { clearCheckIn, setCheckIn } from "@/lib/checkins";
import { requireSameOrigin } from "@/lib/csrf";
import { JSON_BODY_LIMIT, errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; date: string }> };

/**
 * PUT /api/habits/:id/check-ins/:date (YYYY-MM-DD, today minus 7 days to today in the user's zone).
 * Body: { value?: "2.5" } (numeric habits; yes/no habits may send {} or nothing). Repeating it is harmless.
 */
export async function PUT(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id, date } = await ctx.params;
    const bytes = await readBodyCapped(request, JSON_BODY_LIMIT);
    const body = bytes.length === 0 ? {} : parseJsonBody(bytes);
    return Response.json({ checkIn: await setCheckIn(user, id, date, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/habits/:id/check-ins/:date: uncheck that day. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id, date } = await ctx.params;
    await clearCheckIn(user, id, date);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
