import type { ReactNode } from "react";

export function PanelHeader({
  id,
  title,
  count,
  action,
}: {
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-3 font-display text-2xl font-semibold">
        {title}
        {count !== undefined && (
          <span className="rounded-md bg-idle-soft px-2 py-0.5 font-sans text-sm font-medium text-idle">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}
