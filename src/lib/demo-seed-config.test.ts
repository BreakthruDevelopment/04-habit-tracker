import { describe, expect, it } from "vitest";
import { demoSeedConfig } from "./demo-seed-config";
import { isDemoEmail } from "./demo-identity";

const ok = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DATABASE_URL: "postgres://app:app@localhost:5432/app", DEMO_PASSWORD: "a-long-demo-password" };

describe("demoSeedConfig", () => {
  it("accepts a local app and database", () => {
    expect(demoSeedConfig(ok)).toEqual({ appUrl: "http://localhost:3000", password: "a-long-demo-password" });
  });

  it("refuses without DEMO_SEED=yes, a valid APP_URL or a real password", () => {
    expect(() => demoSeedConfig({ ...ok, DEMO_SEED: undefined })).toThrow(/DEMO_SEED=yes/);
    expect(() => demoSeedConfig({ ...ok, APP_URL: "nope" })).toThrow(/valid URL/);
    expect(() => demoSeedConfig({ ...ok, DEMO_PASSWORD: "short" })).toThrow();
  });

  it("refuses the production origin and sslip.io previews of the Oracle VM", () => {
    for (const url of ["https://app4.breakthruventures.ai", "https://APP4.breakthruventures.ai./", "http://1-2-3-4.sslip.io", "https://sslip.io"]) {
      expect(() => demoSeedConfig({ ...ok, APP_URL: url }), url).toThrow(/production host/);
    }
  });

  it("refuses the VM's compose database host `postgres`", () => {
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL: "postgres://postgres:x@postgres:5432/habit" })).toThrow(/production database/);
    expect(() => demoSeedConfig({ ...ok, DATABASE_URL: "postgres://postgres:x@Postgres.:5432/habit" })).toThrow(/production database/);
  });
});

describe("demoSeedConfig (Cloud SQL)", () => {
  it("refuses a Cloud SQL socket database", () => {
    for (const DATABASE_URL of ["postgres://u:p@/db?host=/cloudsql/proj:us-central1:inst", "postgres://u:p@/db?host=%2Fcloudsql%2Fproj%3Aus%3Ainst"]) {
      expect(() => demoSeedConfig({ ...ok, DATABASE_URL })).toThrow(/production database/);
    }
  });
});

describe("isDemoEmail", () => {
  it("matches the demo domain only", () => {
    expect(isDemoEmail("ada@demo.breakthru.test")).toBe(true);
    expect(isDemoEmail(" ADA@Demo.Breakthru.Test ")).toBe(true);
    expect(isDemoEmail("ada@example.test")).toBe(false);
    expect(isDemoEmail("ada@evil-demo.breakthru.test.example")).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });
});
