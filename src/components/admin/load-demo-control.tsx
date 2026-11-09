"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { sendJson } from "@/lib/client-api";

type Result = { users: number; habits: number; checkIns: number; coachSummaries: number };

/** Load the demo workspace behind a confirm step. The route's 409 and 429 messages are shown as they come. */
export function LoadDemoControl() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setPending(true);
    setError("");
    setMessage("");
    const res = await sendJson("POST", "/api/admin/demo", undefined, AbortSignal.timeout(30_000));
    setPending(false);
    setConfirming(false);
    if (res.ok) {
      const r = res.data as Result;
      setMessage(`Loaded ${r.users} demo users, ${r.habits} habits, ${r.checkIns} check-ins and ${r.coachSummaries} coach summaries.`);
      router.refresh();
    } else {
      setError(res.message);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Replaces the demo people&apos;s habits, check-ins and coach summaries with sample data. Other accounts are left alone.</p>
      {confirming ? (
        <div className="space-y-3" aria-busy={pending}>
          <p className="break-words text-base font-medium">Replace the demo people&apos;s data now?</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" disabled={pending} onClick={() => void load()} className={`${buttonPrimary} w-full sm:w-auto`}>
              {pending ? "Loading…" : "Yes, load demo workspace"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={`${buttonSecondary} w-full sm:w-auto`}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`${buttonSecondary} w-full sm:w-auto`}
          onClick={() => {
            setError("");
            setMessage("");
            setConfirming(true);
          }}
        >
          Load demo workspace
        </button>
      )}
      {error && (
        <p role="alert" className="break-words text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <p role="status" className="break-words text-sm">
        {message}
      </p>
    </div>
  );
}
