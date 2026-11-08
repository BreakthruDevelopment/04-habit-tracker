import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { adminCounts } from "@/lib/progress";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats (admin): aggregate counts and caps only. No names, emails, habits or check-in rows. */
export async function GET() {
  try {
    return Response.json({ stats: await adminCounts(await requireRole("admin")) });
  } catch (err) {
    return errorResponse(err);
  }
}
