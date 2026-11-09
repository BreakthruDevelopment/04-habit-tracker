"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui";
import { sendJson } from "@/lib/client-api";
import { TZ_CHANGES_PER_DAY } from "@/lib/domain";
import { clockLabel, reminderOptions } from "@/lib/format";

type Saved = { timeZone: string; reminderTime: string | null };

const OPTIONS = reminderOptions();

/** The browser's own list of zones, plus UTC and the current one, so the saved value always has an option. */
function zoneList(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    // Older browsers: the fallback below is enough.
  }
  return [...new Set(["UTC", current, ...zones])].sort((a, b) => a.localeCompare(b));
}

/** Time zone and reminder time. `initial` is null before the first sign-in has reported the browser's zone. */
export function SettingsForm({ initial }: { initial: Saved | null }) {
  const router = useRouter();
  const id = useId();
  const [saved, setSaved] = useState<Saved | null>(initial);
  const [detected, setDetected] = useState("");
  const [zones, setZones] = useState<string[]>([]);
  const [timeZone, setTimeZone] = useState(initial?.timeZone ?? "UTC");
  const [reminderTime, setReminderTime] = useState(initial?.reminderTime ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Browser-only values are read after mount so the server and client markup match.
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetected(zone);
    setZones(zoneList(initial?.timeZone ?? zone ?? "UTC"));
    if (!initial && zone) setTimeZone(zone);
  }, [initial]);

  const dirty = !saved || timeZone !== saved.timeZone || (reminderTime || null) !== saved.reminderTime;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    const signal = AbortSignal.timeout(10_000);
    // No row yet: let the server create it from the browser's zone, so that isn't counted as a zone change.
    if (!saved) {
      const first = await sendJson("POST", "/api/settings/detect", { detectedZone: detected || timeZone }, signal);
      if (!first.ok) {
        setPending(false);
        setError(first.message);
        return;
      }
      setSaved((first.data as { settings: Saved }).settings);
    }
    const body: { timeZone?: string; reminderTime?: string | null } = { reminderTime: reminderTime || null };
    if (timeZone !== (saved?.timeZone ?? timeZone) || !saved) body.timeZone = timeZone;
    const res = await sendJson("PATCH", "/api/settings", body, signal);
    setPending(false);
    if (!res.ok) {
      setError(res.fields.timeZone ?? res.fields.reminderTime ?? res.message);
      return;
    }
    const next = (res.data as { settings: Saved }).settings;
    setSaved(next);
    setTimeZone(next.timeZone);
    setReminderTime(next.reminderTime ?? "");
    setMessage(next.reminderTime ? `Saved. Reminders come at ${clockLabel(next.reminderTime)} if something is still open.` : "Saved. Reminders are off.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-5" aria-busy={pending} noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className={labelClass} htmlFor={`${id}-tz`}>
          Time zone
          <select
            id={`${id}-tz`}
            name="timeZone"
            className={inputClass}
            value={timeZone}
            disabled={pending}
            aria-describedby={`${id}-tz-hint`}
            onChange={(e) => setTimeZone(e.target.value)}
          >
            {(zones.length > 0 ? zones : [timeZone]).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <span id={`${id}-tz-hint`} className="block text-sm font-normal text-muted">
            Decides which day a check-in belongs to. You can change it {TZ_CHANGES_PER_DAY} times in 24 hours.
          </span>
        </label>
        <label className={labelClass} htmlFor={`${id}-time`}>
          Reminder time
          <select
            id={`${id}-time`}
            name="reminderTime"
            className={inputClass}
            value={reminderTime}
            disabled={pending}
            aria-describedby={`${id}-time-hint`}
            onChange={(e) => setReminderTime(e.target.value)}
          >
            <option value="">No reminders</option>
            {OPTIONS.map((t) => (
              <option key={t} value={t}>
                {clockLabel(t)}
              </option>
            ))}
          </select>
          <span id={`${id}-time-hint`} className="block text-sm font-normal text-muted">
            In your time zone, from 5:00 AM to 9:00 PM. Sent only when a habit is still open.
          </span>
        </label>
      </div>

      {detected && saved && detected !== saved.timeZone && timeZone === saved.timeZone && (
        <div className="space-y-2">
          <p className="break-words text-sm text-muted">Your browser reports {detected.replace(/_/g, " ")}.</p>
          <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} disabled={pending} onClick={() => setTimeZone(detected)}>
            Use {detected.replace(/_/g, " ")}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={`${buttonPrimary} w-full sm:w-auto`} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save settings"}
        </button>
        <p role="status" className="min-w-0 break-words text-sm">
          {message}
        </p>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
