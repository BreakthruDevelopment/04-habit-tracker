import { useId, type ReactNode } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { PanelHeader } from "./PanelHeader";

/** A titled white panel. `collapsible` swaps in the small client component that adds the toggle. */
export function Panel({
  id,
  title,
  count,
  action,
  collapsible = false,
  defaultOpen = true,
  openLabel = "Hide",
  closedLabel = "Show all",
  children,
}: {
  /** Heading id; generated when omitted. */
  id?: string;
  title: string;
  count?: number;
  action?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  openLabel?: string;
  closedLabel?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const headingId = id ?? `panel-${autoId}`;
  if (collapsible) {
    return (
      <CollapsiblePanel
        headingId={headingId}
        action={action}
        title={title}
        count={count}
        defaultOpen={defaultOpen}
        openLabel={openLabel}
        closedLabel={closedLabel}
      >
        {children}
      </CollapsiblePanel>
    );
  }
  return (
    <section aria-labelledby={headingId} className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PanelHeader id={headingId} title={title} count={count} action={action} />
      {children}
    </section>
  );
}
