"use client";

import { useId, useState, type ReactNode } from "react";
import { PanelHeader } from "./PanelHeader";
import { buttonSecondary } from "./styles";

export function CollapsiblePanel({
  headingId,
  action,
  title,
  count,
  defaultOpen,
  openLabel,
  closedLabel,
  children,
}: {
  headingId: string;
  action?: ReactNode;
  title: string;
  count?: number;
  defaultOpen: boolean;
  openLabel: string;
  closedLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section aria-labelledby={headingId} className="mb-6 rounded-card border border-border bg-surface p-4 sm:p-5">
      <PanelHeader
        id={headingId}
        title={title}
        count={count}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {action}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            className={buttonSecondary}
          >
            {open ? openLabel : closedLabel}
            <span aria-hidden>{open ? "⌃" : "⌄"}</span>
          </button>
          </div>
        }
      />
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
