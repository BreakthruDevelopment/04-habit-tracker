import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { detectZoneSchema, getOrCreateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/detect. Body: { detectedZone: "Europe/London" } (the browser's
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`). Creates the settings row on first sign-in, starting from
 * that zone when we accept it (else UTC); once the row exists the zone is ignored. Returns `{ settings }`.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { detectedZone } = detectZoneSchema.parse(await readJson(request));
    return Response.json({ settings: await getOrCreateSettings(user, detectedZone) });
  } catch (err) {
    return errorResponse(err);
  }
}
