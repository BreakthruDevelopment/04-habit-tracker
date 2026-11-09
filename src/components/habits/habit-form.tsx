"use client";

import { useId, useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { sendJson } from "@/lib/client-api";

export type HabitFormValues = {
  id: string;
  name: string;
  kind: "check" | "numeric";
  unit: string | null;
  dailyTarget: string | null;
  weeklyGoal: number;
  updatedAt: string;
};

const errorClass = "break-words text-sm font-medium text-danger";

/**
 * Create (no `habit`) or edit one habit. Edit sends the `updatedAt` conflict token; a 409 says so and offers
 * "Reload latest", which asks the parent for fresh data (the form is re-keyed on the token, so it resets).
 */
export function HabitForm({
  habit,
  onDone,
  onCancel,
  onReload,
}: {
  habit?: HabitFormValues;
  onDone: (message: string) => void;
  onCancel?: () => void;
  onReload?: () => void;
}) {
  const uid = useId();
  const [kind, setKind] = useState<"check" | "numeric">(habit?.kind ?? "check");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "");
    const numeric = kind === "numeric";
    const body: Record<string, unknown> = {
      name,
      kind,
      weeklyGoal: Number(data.get("weeklyGoal")),
      unit: numeric ? String(data.get("unit") ?? "").trim() || null : null,
      dailyTarget: numeric ? String(data.get("dailyTarget") ?? "").trim() || null : null,
    };
    if (habit) body.updatedAt = habit.updatedAt;
    setError("");
    setConflict(false);
    setFields({});
    setPending(true);
    const res = habit ? await sendJson("PATCH", `/api/habits/${habit.id}`, body) : await sendJson("POST", "/api/habits", body);
    setPending(false);
    if (res.ok) {
      if (!habit) {
        form.reset();
        setKind("check");
      }
      onDone(habit ? `Saved ${name.trim()}.` : `Added ${name.trim()}.`);
      return;
    }
    setConflict(res.status === 409 && Boolean(habit));
    setFields(res.fields);
    setError(res.message);
  }

  const field = (key: string) => ({
    "aria-invalid": fields[key] ? true : undefined,
    "aria-describedby": fields[key] ? `${uid}-${key}-err` : undefined,
  });
  const fieldError = (key: string) =>
    fields[key] && (
      <span id={`${uid}-${key}-err`} className={errorClass}>
        {fields[key]}
      </span>
    );

  return (
    <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <label className={labelClass}>
        Name
        <input name="name" required maxLength={60} defaultValue={habit?.name} disabled={pending} className={inputClass} {...field("name")} />
        {fieldError("name")}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelClass}>
          Type
          <select
            name="kind"
            value={kind}
            disabled={pending}
            onChange={(e) => setKind(e.target.value as "check" | "numeric")}
            className={inputClass}
          >
            <option value="check">Yes or no</option>
            <option value="numeric">A number (glasses, minutes, steps…)</option>
          </select>
        </label>
        <label className={labelClass}>
          Goal days per week
          <select name="weeklyGoal" defaultValue={habit?.weeklyGoal ?? 7} disabled={pending} className={inputClass} {...field("weeklyGoal")}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n === 7 ? "Every day (7)" : `${n} ${n === 1 ? "day" : "days"}`}
              </option>
            ))}
          </select>
          {fieldError("weeklyGoal")}
        </label>
      </div>
      {kind === "numeric" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            Daily target
            <input
              name="dailyTarget"
              required
              inputMode="decimal"
              defaultValue={habit?.dailyTarget ?? ""}
              placeholder="8"
              disabled={pending}
              className={inputClass}
              {...field("dailyTarget")}
            />
            {fieldError("dailyTarget")}
          </label>
          <label className={labelClass}>
            Unit
            <input
              name="unit"
              required
              maxLength={16}
              defaultValue={habit?.unit ?? ""}
              placeholder="glasses"
              disabled={pending}
              className={inputClass}
              {...field("unit")}
            />
            {fieldError("unit")}
          </label>
        </div>
      )}
      {error && (
        <div role="alert" className="space-y-3 break-words rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm font-medium text-danger">
          <p>{conflict ? "This habit changed since you opened it. Reload to see the latest version, then make your change again." : error}</p>
          {conflict && onReload && (
            <button type="button" className={buttonSecondary} onClick={onReload}>
              Reload latest
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
          {pending ? "Saving…" : habit ? "Save changes" : "Add habit"}
        </button>
        {onCancel && (
          <button type="button" disabled={pending} onClick={onCancel} className={`${buttonSecondary} w-full sm:w-auto`}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
