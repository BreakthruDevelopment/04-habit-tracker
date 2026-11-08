/** Shared class strings so every button and field in every app has the same size, focus and disabled look. */
export const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const buttonPrimary = `${buttonBase} bg-accent text-accent-foreground hover:opacity-90`;

export const buttonSecondary = `${buttonBase} border border-border bg-surface text-foreground hover:bg-accent-soft`;

export const buttonOutlineAccent = `${buttonBase} border border-accent bg-surface text-accent hover:bg-accent-soft`;

export const buttonDanger = `${buttonBase} border border-border bg-surface text-danger hover:bg-blocked-soft`;

export const inputClass =
  "min-h-11 w-full rounded-card border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus:border-accent";

export const labelClass = "block space-y-1 text-sm font-medium";
