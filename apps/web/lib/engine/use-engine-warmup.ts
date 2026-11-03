"use client";

import { useEffect } from "react";
import { warmEngine } from "./client";

const WARMED_AT_KEY = "mixray-warmed-at";
// The engine allows one warm-up in this interval anyway; asking more often only costs requests.
const WARM_AGAIN_AFTER_MS = 15 * 60 * 1000;

function warmedRecently(now: number): boolean {
  try {
    return now - Number(sessionStorage.getItem(WARMED_AT_KEY) ?? 0) < WARM_AGAIN_AFTER_MS;
  } catch {
    return false;
  }
}

function markWarmed(now: number): void {
  try {
    sessionStorage.setItem(WARMED_AT_KEY, String(now));
  } catch {
    // Without storage the engine's own limit still holds.
  }
}

/** Opening the studio starts the GPU, so it is loaded by the time a sound is chosen. */
export function useEngineWarmup(): void {
  useEffect(() => {
    const now = Date.now();
    if (warmedRecently(now)) return;
    markWarmed(now);
    void warmEngine().catch(() => undefined);
  }, []);
}
