/** consumeRate holds under a race only inside a transaction, which its `Tx` type now requires. */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rate limits (Postgres)", () => {
  let sql: postgres.Sql;
  let usage: typeof import("@/lib/usage");
  let database: ReturnType<typeof import("@/lib/db").db>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`insert into "user" (id, name, email) values ('use-a', 'a', 'use-a@test.local') on conflict do nothing`;
    usage = await import("@/lib/usage");
    database = (await import("@/lib/db")).db();
  });
  afterAll(async () => {
    await sql`delete from "user" where id like 'use-%'`;
    await sql.end();
  });

  it("lets exactly `limit` of 20 parallel calls through", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => database.transaction((tx) => usage.consumeRate(tx, "use-a", "checkin", 5, "slow down"))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 429)).toHaveLength(15);
  });

  it("rateIsFull reads the same window", async () => {
    expect(await usage.rateIsFull("use-a", "checkin", 5)).toBe(true);
    expect(await usage.rateIsFull("use-a", "checkin", 6)).toBe(false);
    expect(await usage.rateIsFull("use-a", "checkin", 5, { windowSeconds: 0 })).toBe(false);
  });

  it("does not accept a pool handle (type-level)", () => {
    // @ts-expect-error a pool handle is not a transaction
    void (() => usage.consumeRate(database, "use-a", "checkin", 5, "x"));
  });
});
