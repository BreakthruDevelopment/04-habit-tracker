"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getJson, sendJson } from "@/lib/client-api";

const FLAG = "habits.settings-checked";

/**
 * First sign-in: when the user has no settings yet, report the browser's time zone once so Today and the reminders
 * use the right local day. Renders nothing. GET never writes; only the POST creates the row.
 */
export function SettingsBootstrap({ userId }: { userId: string }) {
  const router = useRouter();
  useEffect(() => {
    try {
      if (sessionStorage.getItem(FLAG) === userId) return;
    } catch {
      // Storage blocked: check once per page load instead.
    }
    void (async () => {
      const res = await getJson("/api/settings");
      if (!res.ok) return;
      try {
        sessionStorage.setItem(FLAG, userId);
      } catch {
        // Ignore.
      }
      if ((res.data as { settings: unknown } | null)?.settings !== null) return;
      const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!detectedZone) return;
      const created = await sendJson("POST", "/api/settings/detect", { detectedZone }, AbortSignal.timeout(10_000));
      if (created.ok) router.refresh();
    })();
  }, [router, userId]);
  return null;
}
