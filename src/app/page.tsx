import Link from "next/link";
import { DemoBadge, PageIntro, Panel, StatusBadge, buttonPrimary, buttonSecondary } from "@/components/ui";

const features = [
  { title: "Sign-in with roles", body: "Email and password out of the box, OIDC providers by config, admin and user roles enforced on the server." },
  { title: "Postgres", body: "Typed schema and migrations with Drizzle. Every query checks who is asking." },
  { title: "AI feature", body: "One gateway for every model call: input limits, validated JSON output, and a demo fallback." },
  { title: "Any cloud", body: "One container image, deployed to AWS, Azure, Google Cloud or Oracle Cloud with Terraform." },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Template"
        title="A production-shaped starting point."
        description="Each app in the portfolio starts from this template and replaces the example items with its own domain and AI feature."
        actions={
          <>
            <Link href="/sign-in" className={buttonPrimary}>
              Get started
            </Link>
            <Link href="/api/health" className={buttonSecondary}>
              Health check
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.title} title={f.title}>
            <p className="text-muted">{f.body}</p>
          </Panel>
        ))}
      </div>
      <Panel title="Status labels" action={<DemoBadge />}>
        <p className="mb-3 text-muted">
          The shared badges used across the portfolio. Not started is neutral, never an error.
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="live" />
          <StatusBadge status="building" />
          <StatusBadge status="blocked" />
          <StatusBadge status="not-started" />
        </div>
      </Panel>
    </>
  );
}
