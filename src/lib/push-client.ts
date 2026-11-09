/**
 * Browser-side helpers for Web Push. Client code only; no server imports.
 *
 * The permission state machine for the Settings panel (issue 7) is `pushState()`:
 *   unsupported -> "This browser can't show reminders"
 *   ios-install -> iPhone/iPad Safari in a tab: reminders work only from the Home Screen
 *   denied      -> the site can't ask again; explain how to re-enable in browser settings
 *   default     -> show "Turn on reminders on this device" (only a tap may call enablePush)
 *   on          -> permission granted AND this browser has a subscription ("On for this device")
 * "granted" with no subscription is shown as `default`-like (`granted`): the button still calls enablePush, which
 * skips the permission prompt.
 */

export type PushState = "unsupported" | "ios-install" | "denied" | "default" | "granted" | "on";

export type PushEnv = {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  standalone: boolean;
  permission: NotificationPermission | null;
  subscribed: boolean;
};

/** Pure, so it can be unit tested. */
export function derivePushState(e: PushEnv): PushState {
  // iOS only exposes PushManager to Home Screen apps, so check the install case before "unsupported".
  if (e.isIos && !e.standalone) return "ios-install";
  if (!e.hasServiceWorker || !e.hasPushManager || !e.hasNotification) return "unsupported";
  if (e.permission === "denied") return "denied";
  if (e.permission === "granted") return e.subscribed ? "on" : "granted";
  return "default";
}

const SW_URL = "/sw.js";

/** Register the service worker (push only). Never asks for permission. Safe to call on every page. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

export async function readPushState(): Promise<PushState> {
  const w = window as Window & { MSStream?: unknown };
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const hasNotification = "Notification" in w;
  return derivePushState({
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in w,
    hasNotification,
    isIos,
    standalone,
    permission: hasNotification ? Notification.permission : null,
    subscribed: (await currentSubscription()) !== null,
  });
}

function toKey(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Ask for permission (call ONLY from a tap), subscribe, and save the subscription on the server.
 * Resolves to the new state; throws Error with a plain-words message when the server refuses.
 */
export async function enablePush(): Promise<PushState> {
  const config = (await (await fetch("/api/push/config")).json()) as { enabled: boolean; publicKey: string | null };
  if (!config.enabled || !config.publicKey) throw new Error("Reminders aren't available right now.");
  const reg = (await registerServiceWorker()) ?? undefined;
  if (!reg) throw new Error("This browser can't show reminders.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return readPushState();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(config.publicKey) }));
  const res = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't turn on reminders.");
  }
  return readPushState();
}

/** Delete this device's subscription on the server (404 means it was already gone), then unsubscribe in the browser. Best effort; never throws. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
      keepalive: true,
      signal: AbortSignal.timeout(3000), // sign-out must never hang on this
    });
  } catch {
    // Offline: the server prunes dead subscriptions on its own.
  }
  try {
    await sub.unsubscribe();
  } catch {
    // Nothing more to do.
  }
}
