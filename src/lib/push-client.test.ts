import { describe, expect, it } from "vitest";
import { type PushEnv, derivePushState } from "@/lib/push-client";

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
