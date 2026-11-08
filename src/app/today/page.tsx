import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Today" };
export const dynamic = "force-dynamic";

/** Placeholder so sign-in has somewhere to land. The real Today page is built in issue 8. */
export default async function TodayPage() {
  const user = await requireUserOrRedirect();
  return (
    <>
      <PageIntro section="Today" title={`Hello, ${user.name}`} description="Your habits will appear here." />
      <Panel title="Coming soon">
        <p className="text-muted">The habit list and check-ins arrive in the next releases.</p>
      </Panel>
    </>
  );
}
