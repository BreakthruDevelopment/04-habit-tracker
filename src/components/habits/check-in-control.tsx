"use client";

import { useState } from "react";
import { buttonSecondary, inputClass } from "@/components/ui";
import { sendJson } from "@/lib/client-api";
import { addAmount, cents, parseAmount, stepFor } from "@/lib/format";

export type CheckInState = { value: string | null; done: boolean };
export type CheckInHabit = {
  id: string;
  name: string;
  kind: "check" | "numeric";
  unit: string | null;
  dailyTarget: string | null;
};

const round = "inline-flex min-h-11 min-w-11 items-center justify-center rounded-card border border-border bg-surface text-lg font-semibold text-foreground hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A yes/no toggle or a numeric stepper for one habit on one date. The change shows at once (`onChange` gets the
 * new state), the request goes to the check-in route, and on failure `onChange` gets the old state back and the
 * reason appears under the control. Controls are disabled while their own request is pending.
 */
export function CheckInControl({
  habit,
  date,
  state,
  onChange,
  onBusy,
  onSaved,
}: {
  habit: CheckInHabit;
  date: string;
  state: CheckInState;
  onChange: (next: CheckInState) => void;
  onBusy?: (busy: boolean) => void;
  onSaved?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const url = `/api/habits/${habit.id}/check-ins/${date}`;
  const target = habit.dailyTarget ?? "0";

  /** `null` clears the check-in. */
  async function commit(nextValue: string | null) {
    if (pending) return;
    const prev = state;
    setError("");
    setDraft(null);
    setPending(true);
    onBusy?.(true);
    onChange(
      nextValue === null
        ? { value: null, done: false }
        : { value: nextValue, done: habit.kind === "check" || cents(nextValue) >= cents(target) },
    );
    const res =
      nextValue === null
        ? await sendJson("DELETE", url, undefined, AbortSignal.timeout(15000))
        : await sendJson("PUT", url, habit.kind === "check" ? {} : { value: nextValue }, AbortSignal.timeout(15000));
    setPending(false);
    onBusy?.(false);
    if (!res.ok) {
      onChange(prev);
      setError(res.message);
      return;
    }
    if (nextValue !== null) {
      const saved = (res.data as { checkIn?: { value: string; done: boolean } } | null)?.checkIn;
      if (saved) onChange({ value: saved.value, done: saved.done });
    }
    onSaved?.();
  }

  const errorNote = error && (
    <p role="alert" className="mt-2 break-words text-sm font-medium text-danger">
      {error}
    </p>
  );

  if (habit.kind === "check") {
    return (
      <div>
        <button
          type="button"
          aria-pressed={state.done}
          disabled={pending}
          onClick={() => void commit(state.done ? null : "1")}
          className={
            state.done
              ? "inline-flex min-h-12 min-w-32 items-center justify-center gap-2 rounded-card bg-live px-4 text-base font-semibold text-accent-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 max-sm:w-full"
              : `${buttonSecondary} min-h-12 min-w-32 text-base max-sm:w-full`
          }
        >
          <span aria-hidden>{state.done ? "✓" : "○"}</span>
          Done
          <span className="sr-only"> for {habit.name}</span>
        </button>
        {errorNote}
      </div>
    );
  }

  const current = Number(state.value ?? 0);
  const step = stepFor(Number(target));
  const shown = draft ?? state.value ?? "";
  const unit = habit.unit ?? "";

  function commitDraft() {
    if (draft === null || draft.trim() === (state.value ?? "")) {
      setDraft(null);
      return;
    }
    if (draft.trim() === "" || Number(draft) === 0) {
      void commit(null);
      return;
    }
    const parsed = parseAmount(draft);
    if (!parsed) {
      setDraft(null);
      setError("Enter a number above 0 with at most 2 decimals, up to 100,000.");
      return;
    }
    void commit(parsed);
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          commitDraft();
        }}
        className="flex items-center gap-2"
        aria-label={`${habit.name} amount`}
      >
        <button
          type="button"
          aria-label={`Decrease ${habit.name}`}
          disabled={pending || state.value === null}
          onClick={() => {
            const next = current - step;
            void commit(next > 0 ? addAmount(current, -step) : null);
          }}
          className={round}
        >
          <span aria-hidden>−</span>
        </button>
        <label className="sr-only" htmlFor={`amount-${habit.id}-${date}`}>
          {habit.name}, amount in {unit}
        </label>
        <input
          id={`amount-${habit.id}-${date}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          placeholder="0"
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          className={`${inputClass} w-24 text-center tabular-nums`}
        />
        <button
          type="button"
          aria-label={`Increase ${habit.name}`}
          disabled={pending || current >= 100_000}
          onClick={() => void commit(addAmount(current, Math.min(step, 100_000 - current)))}
          className={round}
        >
          <span aria-hidden>+</span>
        </button>
      </form>
      {errorNote}
    </div>
  );
}
