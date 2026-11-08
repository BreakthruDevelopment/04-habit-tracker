/**
 * Better Auth admin-plugin permissions.
 *
 * Our apps promise that admins see counts, never other users' private data.
 * Better Auth's default `admin` role includes `impersonate` and `set-password`
 * (and the statement list has `impersonate-admins` and `set-email`), which would
 * let an admin become any user or reset their password. This role leaves those out.
 *
 * Deliberately NOT granted to admins: user `impersonate`, `impersonate-admins`,
 * `set-password`, `set-email`, and session `list` (it returns other users' raw session
 * tokens, IP addresses and user agents). Do not add them back.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

export const ac = createAccessControl(defaultStatements);

export const roles = {
  admin: ac.newRole({
    user: ["create", "list", "set-role", "ban", "delete", "get", "update"],
    session: ["revoke", "delete"],
  }),
  user: ac.newRole({ user: [], session: [] }),
};

/** Blocked at the HTTP layer as well, in case a role is ever widened by mistake. */
export const DISABLED_AUTH_PATHS = [
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/set-user-password",
  "/admin/list-user-sessions",
];
