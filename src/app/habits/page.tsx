import type { Metadata } from "next";
import { FreeTierBanner } from "@/components/habits/free-tier-banner";
import { HabitsManager, type ManagedHabit } from "@/components/habits/habits-manager";
import { DemoBadge, PageIntro } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { type HabitView, listHabits } from "@/lib/habits";

export const metadata: Metadata = { title: "Habits" };
export const dynamic = "force-dynamic";

const plain = (h: HabitView): ManagedHabit => ({
  id: h.id,
  name: h.name,
  kind: h.kind,
  unit: h.unit,
  dailyTarget: h.dailyTarget,
  weeklyGoal: h.weeklyGoal,
  updatedAt: h.updatedAt.toISOString(),
});

export default async function HabitsPage() {
  const user = await requireUserOrRedirect();
  const [active, archived] = await Promise.all([listHabits(user), listHabits(user, { archived: true })]);
  return (
    <>
      <PageIntro
        section="Habits"
        title="Your habits"
        description="Add, change, reorder, archive or delete the habits on your Today list."
        actions={isDemoEmail(user.email) ? <DemoBadge /> : undefined}
      />
      <FreeTierBanner />
      <HabitsManager active={active.map(plain)} archived={archived.map(plain)} />
    </>
  );
}
