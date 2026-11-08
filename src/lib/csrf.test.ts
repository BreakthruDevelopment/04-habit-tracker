import { beforeAll, describe, expect, it } from "vitest";

describe("requireSameOrigin", () => {
  let requireSameOrigin: typeof import("@/lib/csrf").requireSameOrigin;
  beforeAll(async () => {
    process.env.APP_URL = "https://app4.example.test";
    process.env.DATABASE_URL ??= "postgres://unused";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    ({ requireSameOrigin } = await import("@/lib/csrf"));
  });
  const req = (origin?: string) => new Request("https://app4.example.test/api/habits", { method: "POST", headers: origin ? { origin } : {} });

  it("accepts our own origin", () => {
    expect(() => requireSameOrigin(req("https://app4.example.test"))).not.toThrow();
  });
  it("refuses a sibling subdomain, and a missing Origin", () => {
    expect(() => requireSameOrigin(req("https://app7.example.test"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(req())).toThrow(/Cross-origin/);
  });
});
