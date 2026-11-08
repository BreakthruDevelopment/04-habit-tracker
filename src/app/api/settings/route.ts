import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getOrCreateSettings, updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings[?detectedZone=Europe/London]. On the first call the row is created, starting from
 * `detectedZone` (the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`) when we accept it, else UTC.
 * Later calls ignore it. This is how the client reports the browser zone on first sign-in.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const detected = new URL(request.url).searchParams.get("detectedZone");
    return Response.json({ settings: await getOrCreateSettings(user, detected) });
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
