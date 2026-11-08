import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getSettings, updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings: `{ settings }`, or `{ settings: null }` before the row exists. Read-only, so a cross-site
 * navigation can't change anything. The first sign-in reports the browser's zone with POST /api/settings/detect.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ settings: await getSettings(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/settings. Body: { timeZone?, reminderTime?: "HH:MM" | null }. The 4th zone change in 24 h is 429. */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json({ settings: await updateSettings(user, (await readJson(request)) as never) });
  } catch (err) {
    return errorResponse(err);
  }
}
