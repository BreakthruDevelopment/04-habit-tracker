import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listDevices, subscribe, unsubscribe } from "@/lib/push";

export const dynamic = "force-dynamic";

/** GET /api/push/subscriptions: `{ devices: [{ id, endpoint, deviceLabel, createdAt, lastSuccessAt }] }`, the caller's own. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ devices: await listDevices(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/push/subscriptions. Body: the browser's `{ endpoint, keys: { p256dh, auth } }`. 201 `{ device }`. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const device = await subscribe(user, await readJson(request), request.headers.get("user-agent"));
    return Response.json({ device }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/push/subscriptions. Body: `{ endpoint }` or `{ id }`; own rows only. 204, or 404 if not found. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    await unsubscribe(user, await readJson(request));
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
