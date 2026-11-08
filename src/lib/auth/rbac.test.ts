import { describe, expect, it } from "vitest";
import { ForbiddenError, assertCan, can, toRole } from "./rbac";

const alice = { id: "alice", role: "user" as const };
const bob = { id: "bob", role: "user" as const };
const admin = { id: "root", role: "admin" as const };

describe("can", () => {
  it("lets any signed-in user create", () => {
    expect(can(alice, "create")).toBe(true);
  });

  it("lets owners read, update and delete their own resources", () => {
    const mine = { ownerId: "alice" };
    for (const action of ["read", "update", "delete"] as const) {
      expect(can(alice, action, mine)).toBe(true);
    }
  });

  it("blocks users from other users' resources", () => {
    const hers = { ownerId: "alice" };
    for (const action of ["read", "update", "delete"] as const) {
      expect(can(bob, action, hers)).toBe(false);
    }
  });

  it("denies non-create actions when no resource is given", () => {
    expect(can(alice, "delete")).toBe(false);
  });

  it("lets admins do anything", () => {
    expect(can(admin, "delete", { ownerId: "alice" })).toBe(true);
  });
});

describe("assertCan", () => {
  it("throws ForbiddenError with status 403", () => {
    expect(() => assertCan(bob, "delete", { ownerId: "alice" })).toThrow(ForbiddenError);
  });
});

describe("toRole", () => {
  it("defaults to user", () => {
    expect(toRole(null)).toBe("user");
    expect(toRole("")).toBe("user");
    expect(toRole("viewer")).toBe("user");
  });

  it("reads admin from a comma-separated list", () => {
    expect(toRole("user, admin")).toBe("admin");
  });
});
