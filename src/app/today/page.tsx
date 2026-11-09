import type { Metadata } from "next";
import { TodayList, type TodayItem } from "@/components/habits/today-list";
import { DemoBadge, PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { fullDay } from "@/lib/format";
import { today } from "@/lib/progress";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Today" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const user = await requireUserOrRedirect();
  const [view, settings] = await Promise.all([today(user), getSettings(user)]);
  const items: TodayItem[] = view.habits.map((h) => ({
    id: h.id,
    name: h.name,
    kind: h.kind,
    unit: h.unit,
    dailyTarget: h.dailyTarget,
    weeklyGoal: h.weeklyGoal,
    value: h.value,
    done: h.done,
    streak: h.streak,
    week: { dots: h.week.dots, doneDays: h.week.doneDays },
  }));
  return (
    <>
      <PageIntro
        section="Today"
        title={fullDay(view.date)}
        description={`Hello, ${user.name}. Check off what you've done; changes save as you tap.`}
        actions={isDemoEmail(user.email) ? <DemoBadge /> : undefined}
      />
      <TodayList date={view.date} initial={items} reminderSet={settings?.reminderTime != null} />
    </>
  );
}
