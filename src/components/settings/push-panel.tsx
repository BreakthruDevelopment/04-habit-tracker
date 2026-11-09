"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, StatusBadge, buttonOutlineAccent, buttonPrimary, buttonSecondary } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client-api";
import { type PushState, currentSubscription, disablePush, enablePush, readPushState } from "@/lib/push-client";

type Device = { id: string; endpoint: string; deviceLabel: string; createdAt: string; lastSuccessAt: string | null };
type Notice = { kind: "ok" | "error"; text: string };

const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const day = (iso: string) => date.format(new Date(iso));

function ShareIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

/** The Home Screen steps, shown to iPhone and iPad Safari in a tab. Exported for the /today hint. */
export function IosSteps() {
  const steps = [
    { icon: <ShareIcon />, text: "Tap the Share button in Safari's toolbar." },
    { icon: <AddIcon />, text: "Scroll down and tap Add to Home Screen, then Add." },
    { icon: <HomeIcon />, text: "Open Habits from your Home Screen, then come back to Settings to turn on reminders." },
  ];
  return (
    <ol className="space-y-3" aria-label="Add Habits to your Home Screen">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3 rounded-card border border-border bg-background p-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground" aria-hidden>
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 break-words text-base">
            <span className="sr-only">Step {i + 1}: </span>
            {s.text}
          </span>
          {s.icon}
        </li>
      ))}
    </ol>
  );
}

/** "Reminders on this device": the permission state machine, the test button and the device list. Only a tap asks for permission. */
export function PushPanel() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [available, setAvailable] = useState(true);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [devicesError, setDevicesError] = useState("");
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "enable" | "disable" | "test" | string>("");
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const [s, sub, config, list] = await Promise.all([readPushState(), currentSubscription(), getJson("/api/push/config"), getJson("/api/push/subscriptions")]);
    setState(s);
    setThisEndpoint(sub?.endpoint ?? null);
    if (config.ok) setAvailable((config.data as { enabled: boolean }).enabled !== false);
    if (list.ok) {
      setDevices((list.data as { devices: Device[] }).devices);
      setDevicesError("");
    } else {
      setDevicesError(list.message);
    }
  }, []);

  useEffect(() => {
    // Reads this browser's push state and the server's device list once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error && err.message ? err.message : "Something went wrong. Try again." });
    } finally {
      setBusy("");
    }
  }

  // Called only from the button's onClick: the browser's permission prompt needs a tap.
  const turnOn = () =>
    run("enable", async () => {
      const next = await enablePush();
      await load();
      if (next === "denied") setNotice({ kind: "error", text: "Notifications are blocked for this site. See the steps below to allow them." });
      else if (next === "on") setNotice({ kind: "ok", text: "Reminders are on for this device." });
    });

  const turnOff = () =>
    run("disable", async () => {
      await disablePush();
      await load();
      setNotice({ kind: "ok", text: "Reminders are off for this device." });
    });

  const sendTest = () =>
    run("test", async () => {
      const res = await sendJson("POST", "/api/push/test", undefined, AbortSignal.timeout(15_000));
      if (!res.ok) {
        setNotice({ kind: "error", text: res.message });
        return;
      }
      const r = res.data as { sent: number; removed: number; failed: number };
      if (r.sent > 0) setNotice({ kind: "ok", text: `Test sent to ${r.sent} ${r.sent === 1 ? "device" : "devices"}. It should arrive in a few seconds.` });
      else if (r.removed > 0) setNotice({ kind: "error", text: "That device is no longer reachable and was removed. Turn reminders on again." });
      else setNotice({ kind: "error", text: "The test couldn't be delivered. Try again in a moment." });
      await load();
    });

  const remove = (d: Device) =>
    run(d.id, async () => {
      if (d.endpoint === thisEndpoint) {
        await disablePush();
      } else {
        const res = await sendJson("DELETE", "/api/push/subscriptions", { id: d.id }, AbortSignal.timeout(10_000));
        // 404 means it was already gone, which is what the user wanted.
        if (!res.ok && res.status !== 404) {
          setNotice({ kind: "error", text: res.message });
          return;
        }
      }
      await load();
      setNotice({ kind: "ok", text: `Removed ${d.deviceLabel}.` });
    });

  const anyBusy = busy !== "";
  const hasDevice = (devices?.length ?? 0) > 0;

  return (
    <>
      <Panel title="Reminders on this device">
        <div aria-busy={state === "loading" || anyBusy} className="space-y-4">
          {state === "loading" && <p className="text-muted">Checking this device…</p>}

          {state !== "loading" && !available && state !== "ios-install" && (
            <p className="text-base">Reminders aren&apos;t available right now. Everything else works as usual.</p>
          )}

          {state === "unsupported" && available && <p className="text-base">This browser can&apos;t show reminders. Try Chrome, Edge, Firefox or Safari on a recent device.</p>}

          {state === "ios-install" && (
            <>
              <p className="text-base">On iPhone and iPad, reminders work only from the Home Screen. Add Habits there first:</p>
              <IosSteps />
            </>
          )}

          {state === "denied" && available && (
            <div className="space-y-2 text-base">
              <p>
                <StatusBadge status="blocked" label="Blocked" /> Notifications are blocked for this site, and a site can&apos;t ask again.
              </p>
              <p className="text-muted">To allow them, open your browser&apos;s site settings (the icon at the left of the address bar, or Settings, then Notifications), set this site to Allow, and reload this page.</p>
            </div>
          )}

          {(state === "default" || state === "granted") && available && (
            <div className="space-y-3">
              <p className="text-base">Get a nudge on this device when a habit is still open. Your browser will ask you to allow notifications.</p>
              <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} disabled={anyBusy} onClick={() => void turnOn()}>
                {busy === "enable" ? "Turning on…" : "Turn on reminders on this device"}
              </button>
            </div>
          )}

          {state === "on" && (
            <div className="space-y-3">
              <p className="text-base">
                <StatusBadge status="live" label="On" /> On for this device.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <button type="button" className={`${buttonOutlineAccent} w-full sm:w-auto`} disabled={anyBusy || !hasDevice} onClick={() => void sendTest()}>
                  {busy === "test" ? "Sending…" : "Send a test"}
                </button>
                <button type="button" className={`${buttonSecondary} w-full sm:w-auto`} disabled={anyBusy} onClick={() => void turnOff()}>
                  {busy === "disable" ? "Turning off…" : "Turn off on this device"}
                </button>
              </div>
            </div>
          )}

          <p role={notice?.kind === "error" ? "alert" : "status"} className={`min-w-0 break-words text-sm ${notice?.kind === "error" ? "font-medium text-danger" : ""}`}>
            {notice?.text}
          </p>
        </div>
      </Panel>

      <Panel title="Your devices" count={devices?.length}>
        {devices === null && !devicesError && <p className="text-muted">Loading devices…</p>}
        {devicesError && (
          <p role="alert" className="break-words text-sm font-medium text-danger">
            {devicesError}
          </p>
        )}
        {devices && devices.length === 0 && <p className="text-muted">No devices yet. Turn on reminders on this device to add it.</p>}
        {devices && devices.length > 0 && (
          <ul className="divide-y divide-border">
            {devices.map((d) => {
              const mine = d.endpoint === thisEndpoint;
              return (
                <li key={d.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 break-words font-semibold">
                      {d.deviceLabel}
                      {mine && <StatusBadge status="passed" label="This device" />}
                    </p>
                    <p className="text-sm text-muted">
                      Added {day(d.createdAt)}. {d.lastSuccessAt ? `Last delivered ${day(d.lastSuccessAt)}.` : "Nothing delivered yet."}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`${buttonSecondary} w-full sm:w-auto`}
                    disabled={anyBusy}
                    aria-label={`Remove ${d.deviceLabel}${mine ? " (this device)" : `, added ${day(d.createdAt)}`}`}
                    onClick={() => void remove(d)}
                  >
                    {busy === d.id ? "Removing…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
