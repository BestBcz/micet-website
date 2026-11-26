"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const systemMotion = () => window.matchMedia("(prefers-reduced-motion: no-preference)");

function subscribeSystem(update: () => void) {
  const query = systemMotion();
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function useSiteMotion() {
  return useSyncExternalStore(subscribeSystem, () => systemMotion().matches, () => false);
}

// Telemetry scan-load entrance for keyed lists/tables. Starts immediately if already in viewport.
export function enterRows(group: HTMLElement | null) {
  if (!group || !systemMotion().matches) return;
  const motion = systemMotion();
  let endTimer: number | undefined;
  let observer: IntersectionObserver | undefined;

  const finish = () => {
    observer?.disconnect();
    window.clearTimeout(endTimer);
    delete group.dataset.rowEntry;
  };

  const play = () => {
    group.dataset.rowEntry = "playing";
    observer?.disconnect();
    endTimer = window.setTimeout(finish, 460 + 9 * 28);
  };

  const rect = group.getBoundingClientRect();
  const inView = rect.top < window.innerHeight && rect.bottom > 0;
  if (inView || !("IntersectionObserver" in window)) {
    play();
  } else {
    group.dataset.rowEntry = "waiting";
    observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) play();
    }, { threshold: 0.01 });
    observer.observe(group);
  }

  const finishFocusedRow = (event: FocusEvent) => {
    const row = event.target instanceof Element && event.target.closest<HTMLElement>("[data-entry-row]");
    if (row) row.dataset.entryRow = "done";
  };

  group.addEventListener("focusin", finishFocusedRow);
  motion.addEventListener("change", finish);
  return () => {
    finish();
    group.removeEventListener("focusin", finishFocusedRow);
    motion.removeEventListener("change", finish);
  };
}

// FLIP-style sliding active indicator for navbars and pill strips (zero React re-renders).
export function useSlidingIndicator<T extends HTMLElement>(activeKey: string | number | undefined, inset = 0) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let raf = 0;

    const measure = (instant = false) => {
      const active = container.querySelector<HTMLElement>('[aria-current="page"], [aria-pressed="true"]');
      if (!active) {
        container.dataset.indActive = "false";
        return;
      }
      const cRect = container.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const x = aRect.left - cRect.left + container.scrollLeft + inset;
      const y = aRect.bottom - cRect.top + container.scrollTop - 2;
      const w = Math.max(0, aRect.width - inset * 2);

      if (instant) delete container.dataset.indReady;
      container.style.setProperty("--ind-x", `${x.toFixed(2)}px`);
      container.style.setProperty("--ind-y", `${y.toFixed(2)}px`);
      container.style.setProperty("--ind-w", `${w.toFixed(2)}px`);
      container.dataset.indActive = "true";

      if (instant) {
        window.cancelAnimationFrame(raf);
        raf = window.requestAnimationFrame(() => {
          container.dataset.indReady = "true";
        });
      }
    };

    const first = !container.dataset.indReady;
    measure(first);

    const onResize = () => measure(true);
    let observer: ResizeObserver | undefined;
    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(onResize);
      observer.observe(container);
    }
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [activeKey, inset]);

  return ref;
}
