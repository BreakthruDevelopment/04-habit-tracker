import { describe, expect, it } from "vitest";
import { roles } from "./permissions";

/** The admin role itself lacks the dangerous permissions, so nothing relies on `disabledPaths` alone. */
describe("admin role", () => {
  const can = (statements: Record<string, string[]>) => roles.admin.authorize(statements as never).success;

  it("lacks impersonate, impersonate-admins, set-password and set-email even without disabledPaths", () => {
    for (const action of ["impersonate", "impersonate-admins", "set-password", "set-email"]) {
      expect(can({ user: [action] }), action).toBe(false);
    }
    expect(can({ session: ["list"] })).toBe(false);
  });

  it("keeps what the admin page needs", () => {
    for (const action of ["create", "list", "set-role", "ban", "delete", "get", "update"]) {
      expect(can({ user: [action] }), action).toBe(true);
    }
  });
});
