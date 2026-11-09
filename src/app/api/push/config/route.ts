import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { vapidKeysOrNull } from "@/lib/push";

export const dynamic = "force-dynamic";

/** GET /api/push/config: `{ enabled, publicKey }`. Only the PUBLIC key; `enabled: false` (publicKey null) when keys aren't available. */
export async function GET() {
  try {
    await requireUser();
    const keys = await vapidKeysOrNull();
    return Response.json({ enabled: keys !== null, publicKey: keys?.publicKey ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
