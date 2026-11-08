import "server-only";
import { ForbiddenError } from "@/lib/auth/rbac";
import { env } from "@/lib/env";

/**
 * Cookie-authenticated mutating routes require our own Origin. Other
 * *.breakthruventures.ai apps count as same-site, so Lax cookies alone don't stop
 * them posting here with a visitor's session. A missing Origin is refused too.
 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(env().APP_URL).origin) throw new ForbiddenError("Cross-origin request refused.");
}
