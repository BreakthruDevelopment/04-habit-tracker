import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { deleteHabit, getHabit, updateHabit } from "@/lib/habits";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/habits/:id. Owner only; everyone else (admin included) gets 404. */
export async function GET(_request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ habit: await getHabit(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/habits/:id. Body: { updatedAt, name?, kind?, unit?, dailyTarget?, weeklyGoal?, archived? } (409 when stale). */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json({ habit: await updateHabit(user, id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/habits/:id. Its check-ins go with it. */
export async function DELETE(request: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    await deleteHabit(user, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
