import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./index";
import { type Actor, type Role, ForbiddenError, UnauthorizedError, toRole } from "./rbac";

export type CurrentUser = Actor & { name: string; email: string };

/**
 * The data access layer's single entry point for "who is this?".
 * Returns a narrow user object, never the raw session.
 * Wrapped in React cache(), so the shell and the page share one lookup per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const result = await auth().api.getSession({ headers: await headers() });
  if (!result?.user) return null;
  const u = result.user as typeof result.user & { role?: string | null; banned?: boolean | null };
  if (u.banned) return null;
  return { id: u.id, name: u.name, email: u.email, role: toRole(u.role) };
});

/** For pages: send signed-out visitors to the sign-in page. */
export async function requireUserOrRedirect(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** For pages: signed-in users without the role go to the dashboard. */
export async function requireRoleOrRedirect(role: Role): Promise<CurrentUser> {
  const user = await requireUserOrRedirect();
  if (role === "admin" && user.role !== "admin") redirect("/dashboard");
  return user;
}

/** For route handlers and server actions: throw, so the caller maps it to 401/403. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export async function requireRole(role: Role): Promise<CurrentUser> {
  const user = await requireUser();
  if (role === "admin" && user.role !== "admin") throw new ForbiddenError();
  return user;
}
