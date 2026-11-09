/* Service worker for Web Push only. Deliberately has NO fetch handler: no caching, no stale pages, no cached auth. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Chrome and Safari require a visible notification for every push, so always show one, even if the payload is odd.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Habits";
  const body = typeof data.body === "string" ? data.body : "You have habits left today";
  const url = typeof data.url === "string" ? data.url : "/today";
  const tag = typeof data.tag === "string" && data.tag ? data.tag : "daily-reminder";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag, // a new reminder replaces an old one
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

// Only same-origin targets are opened; anything else goes to /today.
function safeUrl(value) {
  try {
    const target = new URL(value, self.location.origin);
    return target.origin === self.location.origin ? target.href : new URL("/today", self.location.origin).href;
  } catch {
    return new URL("/today", self.location.origin).href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== target) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// Firefox rotates subscriptions: resubscribe with the same public key and tell the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        let key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
        if (!key) {
          const res = await fetch("/api/push/config", { credentials: "same-origin" });
          const config = await res.json();
          if (!config.publicKey) return;
          key = config.publicKey;
        }
        const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await fetch("/api/push/subscriptions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        });
      } catch {
        // The user can turn reminders on again from Settings.
      }
    })(),
  );
});
