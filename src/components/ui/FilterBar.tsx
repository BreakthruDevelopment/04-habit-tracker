import { buttonPrimary, inputClass } from "./styles";

type Option = { value: string; label: string };
type Select = { name: string; label: string; value?: string; options: Option[] };

/**
 * Search, select filters, sort and a table/cards toggle in one GET form, so state lives in the URL
 * and works without JavaScript. The page reads the values from `searchParams`.
 * `hidden` carries other query values (for example a tab) through the submit.
 */
export function FilterBar({
  search,
  filters = [],
  sort,
  view,
  hidden = {},
  label = "Filter",
}: {
  search?: { name?: string; value?: string; placeholder?: string };
  filters?: Select[];
  sort?: Select;
  view?: { name?: string; value: "table" | "cards" };
  hidden?: Record<string, string>;
  /** Accessible name for the search landmark, for example "Filter items". */
  label?: string;
}) {
  const searchName = search?.name ?? "q";
  const viewName = view?.name ?? "view";
  return (
    <form method="get" role="search" aria-label={label} className="mb-4 flex flex-wrap items-end gap-3">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {search && (
        <label className="min-w-0 flex-1 basis-full space-y-1 text-sm font-medium sm:basis-64">
          <span className="sr-only">Search</span>
          <input
            type="search"
            name={searchName}
            defaultValue={search.value}
            placeholder={search.placeholder ?? "Search…"}
            maxLength={100}
            className={inputClass}
          />
        </label>
      )}
      {[...filters, ...(sort ? [sort] : [])].map((s) => (
        <label key={s.name} className="min-w-0 flex-1 basis-[calc(50%-0.375rem)] space-y-1 text-sm font-medium sm:basis-44 sm:flex-none">
          <span className="sr-only">{s.label}</span>
          <select name={s.name} defaultValue={s.value} aria-label={s.label} className={inputClass}>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {view && (
        <fieldset className="flex rounded-card border border-border bg-surface p-0.5">
          <legend className="sr-only">View</legend>
          {(["table", "cards"] as const).map((v) => {
            // Below 640px the list is always cards, so the toggle shows Cards as active there.
            const phoneActive = v === "cards";
            return (
            <label key={v} className="cursor-pointer">
              <input
                type="radio"
                name={viewName}
                value={v}
                defaultChecked={view.value === v}
                className="peer sr-only"
              />
              <span
                className={`inline-flex min-h-11 min-w-20 items-center justify-center rounded-md px-3 text-sm font-semibold capitalize peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
                  phoneActive
                    ? "max-sm:bg-accent max-sm:text-accent-foreground sm:text-foreground sm:peer-checked:bg-accent sm:peer-checked:text-accent-foreground"
                    : "max-sm:text-foreground sm:text-foreground sm:peer-checked:bg-accent sm:peer-checked:text-accent-foreground"
                }`}
              >
                {v}
              </span>
            </label>
            );
          })}
        </fieldset>
      )}
      <button type="submit" className={buttonPrimary}>
        Apply
      </button>
    </form>
  );
}
