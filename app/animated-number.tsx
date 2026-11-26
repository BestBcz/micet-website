"use client";

import { useEffect, useRef } from "react";

function easeOutExpo(t: number) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

// Smooth numeric telemetry count-up with zero SSR hydration mismatch or React re-renders.
export function AnimatedNumber({
  value,
  suffix = "",
  duration = 560,
  className,
}: {
  value: number | null;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<number | null>(null);
  const finalText = value === null ? "—" : Math.round(value).toLocaleString("en-US") + suffix;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const allowMotion = window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
    if (value === null || !allowMotion) {
      node.textContent = finalText;
      previous.current = value;
      return;
    }

    const from = previous.current ?? (value > 120 ? Math.round(value * 0.72) : 0);
    if (from === value) {
      node.textContent = finalText;
      previous.current = value;
      return;
    }

    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = easeOutExpo(progress);
      const current = from + (value - from) * eased;
      node.textContent = progress >= 1 ? finalText : Math.round(current).toLocaleString("en-US") + suffix;
      if (progress < 1) {
        raf = window.requestAnimationFrame(step);
      } else {
        previous.current = value;
      }
    };

    raf = window.requestAnimationFrame(step);
    return () => {
      window.cancelAnimationFrame(raf);
      node.textContent = finalText;
      previous.current = value;
    };
  }, [value, suffix, finalText, duration]);

  return <span ref={ref} className={className}>{finalText}</span>;
}
