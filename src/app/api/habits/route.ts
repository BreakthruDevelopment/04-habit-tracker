import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { createHabit, listHabits } from "@/lib/habits";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/habits[?archived=1]: the caller's own habits, in display order. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    return Response.json({ habits: await listHabits(user, { archived }) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/habits. Body: { name, kind?: "check"|"numeric", unit?, dailyTarget?: "8", weeklyGoal?: 1-7 }. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const habit = await createHabit(user, await readJson(request));
    return Response.json({ habit }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
