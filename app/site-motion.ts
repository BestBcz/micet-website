"use client";

import { useSyncExternalStore } from "react";

const systemMotion = () => window.matchMedia("(prefers-reduced-motion: no-preference)");
function subscribeSystem(update: () => void) {
  const query = systemMotion();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function useSiteMotion() {
  return useSyncExternalStore(subscribeSystem, () => systemMotion().matches, () => false);
}

// A keyed list gets one entrance. Animate its columns so each link keeps its full hit area.
export function enterRows(group: HTMLElement | null) {
  if (!group || !systemMotion().matches || !("IntersectionObserver" in window)) return;
  const motion = systemMotion();
  let endTimer: number | undefined;
  group.dataset.rowEntry = "waiting";
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    group.dataset.rowEntry = "playing";
    observer.disconnect();
    endTimer = window.setTimeout(finish, 320 + 7 * 35);
  });
  observer.observe(group);

  const finishFocusedRow = (event: FocusEvent) => {
    const row = event.target instanceof Element && event.target.closest<HTMLElement>("[data-entry-row]");
    if (row) row.dataset.entryRow = "done";
  };
  const finish = () => {
    observer.disconnect();
    window.clearTimeout(endTimer);
    delete group.dataset.rowEntry;
  };
  group.addEventListener("focusin", finishFocusedRow);
  motion.addEventListener("change", finish);
  return () => {
    finish();
    group.removeEventListener("focusin", finishFocusedRow);
    motion.removeEventListener("change", finish);
  };
}
