import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";
import { sendTestPush } from "@/lib/push";

export const dynamic = "force-dynamic";

/** POST /api/push/test: one "Test reminder" to the caller's own devices. 3 an hour (429). `{ sent, removed, failed }`. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json(await sendTestPush(user));
  } catch (err) {
    return errorResponse(err);
  }
}
