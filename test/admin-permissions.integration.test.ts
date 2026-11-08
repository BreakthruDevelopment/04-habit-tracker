/**
 * Proves admins cannot impersonate users or set their passwords, while the admin
 * features the apps rely on (set-role, ban, remove-user) still work.
 * Runs against a real Postgres when TEST_DATABASE_URL is set.
 * Better Auth's origin check is off under NODE_ENV=test, so requests need no Origin header.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";

describe.skipIf(!url)("admin permissions (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let authApi: Record<string, (args: unknown) => Promise<unknown>>;
  let adminCookie: string;
  let userCookie: string;
  let victimId: string;
  const email = (n: string) => `ap-${n}@test.local`;

  async function call(path: string, body: unknown, cookie?: string) {
    return handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  }

  async function signUp(name: string) {
    const res = await call("/sign-up/email", { name, email: email(name), password: PASSWORD });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    return user.id;
  }

  async function signIn(name: string, password = PASSWORD) {
    const res = await call("/sign-in/email", { email: email(name), password });
    if (res.status !== 200) return null;
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async function cleanup() {
    await sql`delete from "user" where email like 'ap-%@test.local'`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    await cleanup();

    const { auth } = await import("@/lib/auth");
    handler = auth().handler;
    authApi = auth().api as unknown as typeof authApi;

    const adminId = await signUp("admin");
    victimId = await signUp("victim");
    await signUp("plain");
    await sql`update "user" set role = 'admin' where id = ${adminId}`;

    adminCookie = (await signIn("admin"))!;
    userCookie = (await signIn("plain"))!;
    expect(adminCookie && userCookie).toBeTruthy();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const victimSessions = async () =>
    (await sql`select count(*)::int as n from session where user_id = ${victimId}`)[0].n as number;
  const impersonationSessions = async () =>
    (await sql`select count(*)::int as n from session where impersonated_by is not null`)[0]
      .n as number;

  it("refuses impersonate-user over HTTP and creates no session", async () => {
    const before = await victimSessions();
    const res = await call("/admin/impersonate-user", { userId: victimId }, adminCookie);
    expect([403, 404]).toContain(res.status);
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect(await victimSessions()).toBe(before);
    expect(await impersonationSessions()).toBe(0);
  });

  it("refuses impersonation even if the HTTP block were bypassed (role has no permission)", async () => {
    await expect(
      authApi.impersonateUser({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await impersonationSessions()).toBe(0);
  });

  it("refuses set-user-password over HTTP and by role, and the password is unchanged", async () => {
    const res = await call(
      "/admin/set-user-password",
      { userId: victimId, newPassword: "attacker-chosen-pass" },
      adminCookie,
    );
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.setUserPassword({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId, newPassword: "attacker-chosen-pass" },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await signIn("victim", "attacker-chosen-pass")).toBeNull();
    expect(await signIn("victim")).toBeTruthy();
  });

  it("refuses stop-impersonating and admin email changes (account-takeover via reset)", async () => {
    const res = await call("/admin/stop-impersonating", {}, adminCookie);
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.adminUpdateUser({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId, data: { email: "hijack@test.local" } },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await sql`select email from "user" where id = ${victimId}`)[0].email).toBe(
      email("victim"),
    );
  });

  it("refuses list-user-sessions (raw tokens, IPs, user agents) over HTTP and by role", async () => {
    const res = await handler(
      new Request(`http://localhost:3000/api/auth/admin/list-user-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ userId: victimId }),
      }),
    );
    expect([403, 404]).toContain(res.status);
    await expect(
      authApi.listUserSessions({
        headers: new Headers({ cookie: adminCookie }),
        body: { userId: victimId },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("reports impersonate as not permitted for admins via has-permission", async () => {
    const res = await call("/admin/has-permission", { permissions: { user: ["impersonate"] } }, adminCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
  });

  it("does not let a plain user use admin endpoints", async () => {
    const res = await call("/admin/set-role", { userId: victimId, role: "admin" }, userCookie);
    expect(res.status).toBe(403);
    const [row] = await sql`select role from "user" where id = ${victimId}`;
    expect(row.role).not.toBe("admin");
  });

  it("still lets an admin promote and demote a user", async () => {
    let res = await call("/admin/set-role", { userId: victimId, role: "admin" }, adminCookie);
    expect(res.status).toBe(200);
    expect((await sql`select role from "user" where id = ${victimId}`)[0].role).toBe("admin");
    res = await call("/admin/set-role", { userId: victimId, role: "user" }, adminCookie);
    expect(res.status).toBe(200);
    expect((await sql`select role from "user" where id = ${victimId}`)[0].role).toBe("user");
  });

  it("still lets an admin list users, ban and unban", async () => {
    const list = await handler(
      new Request("http://localhost:3000/api/auth/admin/list-users?limit=50", {
        headers: { cookie: adminCookie },
      }),
    );
    expect(list.status).toBe(200);
    let res = await call("/admin/ban-user", { userId: victimId }, adminCookie);
    expect(res.status).toBe(200);
    expect((await sql`select banned from "user" where id = ${victimId}`)[0].banned).toBe(true);
    res = await call("/admin/unban-user", { userId: victimId }, adminCookie);
    expect(res.status).toBe(200);
  });

  it("still lets an admin remove a user", async () => {
    const res = await call("/admin/remove-user", { userId: victimId }, adminCookie);
    expect(res.status).toBe(200);
    expect(await sql`select id from "user" where id = ${victimId}`).toHaveLength(0);
  });
});
