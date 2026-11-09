import type { Metadata } from "next";
import { PushPanel } from "@/components/settings/push-panel";
import { SettingsForm } from "@/components/settings/settings-form";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUserOrRedirect();
  const settings = await getSettings(user);
  return (
    <>
      <PageIntro section="Settings" title="Settings" description="Your time zone, when to be reminded, and which devices get the reminder." />
      <Panel title="Time zone and reminder time">
        <SettingsForm initial={settings ? { timeZone: settings.timeZone, reminderTime: settings.reminderTime } : null} />
      </Panel>
      <PushPanel />
    </>
  );
}
