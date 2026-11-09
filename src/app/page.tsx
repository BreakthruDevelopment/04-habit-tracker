import Link from "next/link";
import { FreeTierBanner } from "@/components/habits/free-tier-banner";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";

const features = [
  { title: "Two-tap check-ins", body: "Tick a yes/no habit or step a number up and down. It saves as you tap, and rolls back if something goes wrong." },
  { title: "Streaks and week dots", body: "See this week's progress at a glance, with day streaks for daily habits and week streaks for the rest." },
  { title: "30-day heatmap", body: "One grid for all your habits and one for each habit, so patterns show up without a chart." },
  { title: "Reminders on your phone", body: "Add the app to your home screen and get a push when something is still open. No native app needed." },
];

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <>
      <PageIntro
        section="Habit and Goal Tracker"
        title="Small habits, checked off daily."
        description="Define a few habits, check them off in two taps, and watch streaks and a 30-day heatmap build up."
        actions={
          user ? (
            <Link href="/today" className={buttonPrimary}>
              Open Today
            </Link>
          ) : (
            <>
              <Link href="/sign-in" className={buttonPrimary}>
                Sign in or create an account
              </Link>
              <Link href="/api/health" className={buttonSecondary}>
                Health check
              </Link>
            </>
          )
        }
      />
      <FreeTierBanner />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.title} title={f.title}>
            <p className="text-muted">{f.body}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}
