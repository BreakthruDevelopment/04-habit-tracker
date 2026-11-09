"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/push-client";

/** Registers the push-only service worker for signed-in users. Renders nothing and never asks for permission. */
export function PushRegistrar() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}
