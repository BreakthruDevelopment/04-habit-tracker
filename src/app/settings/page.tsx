import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/** A stub so the nav link works. Issue 7 replaces it with the time zone, reminder time and device settings. */
export default async function SettingsPage() {
  await requireUserOrRedirect();
  return <PageIntro section="Settings" title="Settings" description="Reminders and time zone settings are coming next." />;
}
