"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonSecondary } from "@/components/ui";

const REMINDER_KEY = "habits.hint.reminders";
const INSTALL_KEY = "habits.hint.install";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function isIosTab(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

/**
 * One dismissible line under the habit list. On iPhone Safari in a tab: how to install, since reminders need the
 * Home Screen. Otherwise, once the user has checked in three times this week and has no reminder time: a nudge to
 * set one up. Decided after mount (it depends on the browser), and never asks for permission.
 */
export function TodayHints({ checkIns, reminderSet }: { checkIns: number; reminderSet: boolean }) {
  const [kind, setKind] = useState<"install" | "reminders" | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Browser-only facts (user agent, display mode, storage) are read once after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed({ install: read(INSTALL_KEY), reminders: read(REMINDER_KEY) });
    setKind(isIosTab() ? "install" : "reminders");
  }, []);

  const key = kind === "install" ? INSTALL_KEY : REMINDER_KEY;
  if (!kind || dismissed[kind]) return null;
  if (kind === "reminders" && (reminderSet || checkIns < 3)) return null;

  function dismiss() {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Dismissed for this visit only.
    }
    setDismissed((d) => ({ ...d, [kind as string]: true }));
  }

  return (
    <aside aria-label={kind === "install" ? "Install tip" : "Reminder tip"} className="mt-6 flex flex-col gap-3 rounded-card border border-border bg-accent-soft p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words text-base">
        {kind === "install"
          ? "Reminders on iPhone need Habits on your Home Screen: tap Share, then Add to Home Screen."
          : "Want a nudge at 8:00 PM when something is still open?"}
      </p>
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
        <Link href="/settings" className={`${buttonSecondary} w-full sm:w-auto`}>
          {kind === "install" ? "See the steps" : "Set up reminders"}
        </Link>
        <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} onClick={dismiss}>
          Dismiss<span className="sr-only"> this tip</span>
        </button>
      </div>
    </aside>
  );
}
