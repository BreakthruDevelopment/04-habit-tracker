import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { summarizeItems } from "@/lib/items";

export const dynamic = "force-dynamic";

/** POST /api/ai/summarize — AI summary of the caller's items. */
export async function POST() {
  try {
    const user = await requireUser();
    const result = await summarizeItems(user);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
