/**
 * Creates a demo admin and a demo user so a fresh deploy has something to show.
 * Passwords come from env, never from the repo:
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_USER_EMAIL, SEED_USER_PASSWORD
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";

const { DATABASE_URL, APP_URL = "http://localhost:3000" } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

const accounts = [
  { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD, name: "Demo Admin", role: "admin" },
  { email: process.env.SEED_USER_EMAIL, password: process.env.SEED_USER_PASSWORD, name: "Demo User", role: "user" },
].filter((a): a is { email: string; password: string; name: string; role: string } => Boolean(a.email && a.password));

if (accounts.length === 0) {
  console.log("No SEED_* accounts set; nothing to seed.");
  process.exit(0);
}

const sql = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(sql, { schema });

try {
  for (const a of accounts) {
    // Sign up through the running app so passwords are hashed exactly as Better Auth expects.
    const res = await fetch(`${APP_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_URL },
      body: JSON.stringify({ email: a.email, password: a.password, name: a.name }),
    });
    if (!res.ok && res.status !== 422) {
      console.warn(`Sign-up for ${a.email} returned HTTP ${res.status}.`);
    }
    // Only report success if the account really exists (sign-up can be rate-limited).
    const updated = await db
      .update(schema.user)
      .set({ role: a.role })
      .where(eq(schema.user.email, a.email))
      .returning({ id: schema.user.id });
    if (updated.length === 0) {
      console.error(`Could not seed ${a.email}: the account doesn't exist. Retry in a minute.`);
      process.exitCode = 1;
      continue;
    }
    console.log(`Seeded ${a.role}: ${a.email}`);
  }
} finally {
  await sql.end();
}
