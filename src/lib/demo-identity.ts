/** Shared by the demo loader and the auth hooks that stop public users faking it. */
export const MARKER = "urn:breakthru:habit-demo:v1";
export const DEMO_EMAIL_DOMAIN = "demo.breakthru.test";

export function isDemoEmail(email: unknown): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}
