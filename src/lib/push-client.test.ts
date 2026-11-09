import { afterEach, describe, expect, it, vi } from "vitest";
import { type PushEnv, derivePushState, enablePush } from "@/lib/push-client";

const base: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, standalone: false, permission: "default", subscribed: false };

describe("derivePushState", () => {
  it("walks the permission state machine", () => {
    expect(derivePushState({ ...base, hasPushManager: false })).toBe("unsupported");
    expect(derivePushState({ ...base, hasServiceWorker: false })).toBe("unsupported");
    expect(derivePushState({ ...base, isIos: true, hasPushManager: false })).toBe("ios-install");
    expect(derivePushState({ ...base, isIos: true, standalone: true })).toBe("default");
    expect(derivePushState({ ...base, permission: "denied" })).toBe("denied");
    expect(derivePushState(base)).toBe("default");
    expect(derivePushState({ ...base, permission: "granted" })).toBe("granted");
    expect(derivePushState({ ...base, permission: "granted", subscribed: true })).toBe("on");
  });
});

describe("enablePush", () => {
  const calls: string[] = [];
  let unsubscribed = 0;
  let existing: unknown = null;

  function setup(postStatus: number, permission: NotificationPermission = "default") {
    calls.length = 0;
    unsubscribed = 0;
    const sub = { endpoint: "https://fcm.googleapis.com/x", toJSON: () => ({ endpoint: "x" }), unsubscribe: async () => void unsubscribed++ };
    const reg = { pushManager: { getSubscription: async () => existing, subscribe: async () => (calls.push("subscribe"), sub) } };
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", {
      userAgent: "test",
      platform: "x",
      maxTouchPoints: 0,
      serviceWorker: { register: async () => (calls.push("register"), reg), ready: Promise.resolve(reg), getRegistration: async () => reg },
    });
    vi.stubGlobal("Notification", { permission, requestPermission: async () => (calls.push("permission"), "granted") });
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(`fetch ${url}`);
      if (url.includes("config")) return Response.json({ enabled: true, publicKey: "AQAB" });
      return Response.json({ error: "Too many devices" }, { status: postStatus });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    existing = null;
  });

  it("asks for permission before any other work", async () => {
    setup(201);
    await enablePush();
    expect(calls[0]).toBe("permission");
  });

  it("undoes a subscription it made when the server refuses", async () => {
    setup(429);
    await expect(enablePush()).rejects.toThrow("Too many devices");
    expect(unsubscribed).toBe(1);
  });

  it("leaves a subscription that was already there", async () => {
    existing = { endpoint: "https://fcm.googleapis.com/x", toJSON: () => ({ endpoint: "x" }), unsubscribe: async () => void unsubscribed++ };
    setup(503, "granted");
    await expect(enablePush()).rejects.toThrow();
    expect(unsubscribed).toBe(0);
    expect(calls).not.toContain("permission");
  });
});
