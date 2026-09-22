"use client";

import { useLayoutEffect, useRef } from "react";
import { isRecentArrival } from "@/lib/arrival";

/** Сколько длится каскад (последний блок + его анимация), мс. */
const CASCADE_MS = 1600;

/**
 * Переход к соседнему проекту — каскадом: старая страница гаснет, а блоки новой
 * (`[data-cascade-item]`, порядок — `--ci`) по очереди въезжают со стороны,
 * куда листали. Ставит `data-cascade` на `<main>`; анимации — в globals.css.
 */
export default function NeighbourCascade() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const main = ref.current?.closest("main");
    if (!main) return;
    const dir = isRecentArrival("proj-next") ? "next" : isRecentArrival("proj-prev") ? "prev" : null;
    if (!dir) return;
    main.dataset.cascade = dir;
    const t = setTimeout(() => delete main.dataset.cascade, CASCADE_MS);
    return () => {
      clearTimeout(t);
      delete main.dataset.cascade;
    };
  }, []);
  return <span ref={ref} hidden />;
}
