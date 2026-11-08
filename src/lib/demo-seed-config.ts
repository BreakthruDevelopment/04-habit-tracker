import { z } from "zod";

/** Checked before importing the database/auth loader, including for CLI refusals. */
export function demoSeedConfig(values: Record<string, string | undefined> = process.env) {
  if (values.DEMO_SEED !== "yes") throw new Error("Demo seed refused: set DEMO_SEED=yes.");
  const parsedUrl = z.string().url().safeParse(values.APP_URL);
  if (!parsedUrl.success) throw new Error("Demo seed refused: set APP_URL to a valid URL.");
  const appUrl = parsedUrl.data;
  const hostname = new URL(appUrl).hostname.toLowerCase().replace(/\.+$/, "");
  // The production origin, any sslip.io preview of the Oracle VM.
  if (hostname === "app4.breakthruventures.ai" || hostname === "sslip.io" || hostname.endsWith(".sslip.io")) {
    throw new Error("Demo seed refused: APP_URL is a production host.");
  }
  // "postgres" is the compose service name on the Oracle VM, i.e. the production database.
  if (databaseHost(values.DATABASE_URL) === "postgres") {
    throw new Error("Demo seed refused: DATABASE_URL is a production database host.");
  }
  const password = z.string().min(10).max(128).parse(values.DEMO_PASSWORD);
  return { appUrl, password };
}

function databaseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}
