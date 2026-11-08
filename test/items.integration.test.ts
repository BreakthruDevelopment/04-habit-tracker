/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one).
 * Proves the ownership rules hold at the data layer, not just in the UI.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("items data layer (Postgres)", () => {
  let sql: postgres.Sql;
  const alice = { id: "it-alice", role: "user" as const };
  const bob = { id: "it-bob", role: "user" as const };
  const admin = { id: "it-admin", role: "admin" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await sql`delete from "user" where id like 'it-%'`;
    for (const u of [alice, bob, admin]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'it-%'`;
    await sql.end();
  });

  it("scopes lists to the owner, and admins see all", async () => {
    const { createItem, listItems } = await import("@/lib/items");
    await createItem(alice, { title: "alice's item" });
    await createItem(bob, { title: "bob's item" });

    const aliceItems = await listItems(alice);
    expect(aliceItems.every((i) => i.ownerId === alice.id)).toBe(true);

    const adminItems = await listItems(admin);
    const owners = new Set(adminItems.map((i) => i.ownerId));
    expect(owners.has(alice.id) && owners.has(bob.id)).toBe(true);
  });

  it("stops a user deleting someone else's item", async () => {
    const { createItem, deleteItem } = await import("@/lib/items");
    const item = await createItem(alice, { title: "protected" });
    await expect(deleteItem(bob, item.id)).rejects.toMatchObject({ status: 403 });
    expect(await deleteItem(alice, item.id)).toBe(true);
  });

  it("validates input", async () => {
    const { createItem } = await import("@/lib/items");
    await expect(createItem(alice, { title: "   " })).rejects.toThrow();
  });
});
