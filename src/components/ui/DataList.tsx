import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** The row's title in card view; shown without a label. Exactly one column should set it. */
  primary?: boolean;
  /** Hide the label in card view (for example a row's action button). */
  hideLabel?: boolean;
  /** Visually hide the table header (for action columns). */
  srOnlyHeader?: boolean;
  className?: string;
};

/**
 * A table from 640px up that becomes compact cards on phones. `view="cards"` forces cards at every width.
 * Pass `empty` for the empty state; it is shown instead of a blank table.
 */
export function DataList<T>({
  columns,
  rows,
  rowKey,
  caption,
  view = "table",
  empty = "Nothing here yet.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  view?: "table" | "cards";
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <div className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">{empty}</div>;
  }
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary);
  const tableOnly = view === "table";

  return (
    <>
      {tableOnly && (
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-background text-muted">
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={`px-3 py-2 font-semibold ${c.className ?? ""}`}>
                    {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((c) =>
                    c === primary ? (
                      <th key={c.key} scope="row" className={`px-3 py-3 text-left align-middle font-normal ${c.className ?? ""}`}>
                        {c.cell(row)}
                      </th>
                    ) : (
                      <td key={c.key} className={`px-3 py-3 align-middle ${c.className ?? ""}`}>
                        {c.cell(row)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul
        aria-label={caption}
        className={tableOnly ? "grid gap-3 sm:hidden" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"}
      >
        {rows.map((row) => (
          <li key={rowKey(row)} className="space-y-2 rounded-card border border-border bg-surface p-4">
            <h3 className="font-semibold break-words">{primary.cell(row)}</h3>
            <dl className="space-y-1 text-sm">
              {rest
                .filter((c) => !c.hideLabel)
                .map((c) => (
                  <div key={c.key} className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 text-muted">{c.header}</dt>
                    <dd className="min-w-0 text-right break-words">{c.cell(row)}</dd>
                  </div>
                ))}
            </dl>
            {rest
              .filter((c) => c.hideLabel)
              .map((c) => (
                <div key={c.key}>{c.cell(row)}</div>
              ))}
          </li>
        ))}
      </ul>
    </>
  );
}
