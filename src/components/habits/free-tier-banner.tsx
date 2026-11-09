/** Shown on every page where people enter or read data: the free-tier AI provider may keep prompts. */
export function FreeTierBanner() {
  return (
    <p
      role="note"
      className="mb-6 rounded-card border border-border bg-building-soft px-4 py-3 text-sm font-medium text-building"
    >
      Demo data only; don&apos;t enter real health information.
    </p>
  );
}
