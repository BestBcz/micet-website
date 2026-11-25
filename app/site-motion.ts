"use client";

import { createContext, useSyncExternalStore } from "react";

type Preference = "system" | "on" | "reduce";
const storageKey = "micet.motion";
let temporaryPreference: Preference | undefined;
export const MotionEnabled = createContext(false);

function readPreference(): Preference {
  if (temporaryPreference) return temporaryPreference;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "on" || stored === "reduce") return stored;
  } catch { /* Storage may be unavailable in a private window. */ }
  return "system";
}

function subscribePreference(update: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) update();
  };
  window.addEventListener("micet-motion", update);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("micet-motion", update);
    window.removeEventListener("storage", onStorage);
  };
}

function setPreference(value: string) {
  if (value !== "system" && value !== "on" && value !== "reduce") return;
  try {
    localStorage.setItem(storageKey, value);
    temporaryPreference = undefined;
  } catch {
    temporaryPreference = value;
  }
  window.dispatchEvent(new Event("micet-motion"));
}

const systemMotion = () => window.matchMedia("(prefers-reduced-motion: no-preference)");
function subscribeSystem(update: () => void) {
  const query = systemMotion();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function useSiteMotion() {
  const preference = useSyncExternalStore(subscribePreference, readPreference, (): Preference => "system");
  const systemEnabled = useSyncExternalStore(subscribeSystem, () => systemMotion().matches, () => false);
  return { preference, setPreference, enabled: preference === "on" || (preference === "system" && systemEnabled) };
}
