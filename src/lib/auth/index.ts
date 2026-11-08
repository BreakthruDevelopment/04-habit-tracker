import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { ac, DISABLED_AUTH_PATHS, roles } from "./permissions";

function createAuth() {
  const e = env();
  return betterAuth({
    appName: e.APP_NAME,
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
    },
    // OIDC providers (Google, Microsoft Entra ID, GitHub, Okta via genericOAuth)
    // plug in here per app; they read their client IDs from env.
    socialProviders: {},
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: e.APP_URL.startsWith("https://"),
    },
    // Admins manage roles, bans and accounts but cannot impersonate or reset passwords
    // (see permissions.ts). The paths are also blocked outright, as a second layer.
    disabledPaths: DISABLED_AUTH_PATHS,
    plugins: [
      admin({ ac, roles, defaultRole: "user", adminRoles: ["admin"] }),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/** Lazily built so `next build` doesn't need a database or secrets. */
export function auth(): Auth {
  if (!instance) instance = createAuth();
  return instance;
}
