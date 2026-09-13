"use client";

import { useEffect, useRef, type ReactNode } from "react";

/* Обёртка: data-reveal="pending" → "in", когда блок впервые попал в экран (дети играют каскад через CSS);
   data-visible стоит, пока блок на экране, — для элементов, которые видны только рядом с ним. */
export default function Stagger({
  className,
  children,
  threshold = 0.15,
  edge,
}: {
  className?: string;
  children: ReactNode;
  /** Какая доля блока должна попасть в экран, чтобы стартовал каскад. */
  threshold?: number;
  /**
   * Альтернативный триггер для последнего раздела: каскад стартует, когда верх
   * блока поднялся выше этой доли высоты экрана (0.4 — верхние 40%) либо страница
   * докручена до конца. Так раздел не срабатывает, пока лишь выглядывает снизу.
   */
  edge?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reveal = () => {
      el.dataset.reveal = "in";
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) reveal();
      },
      edge === undefined
        ? { threshold }
        : { threshold: 0, rootMargin: `0px 0px -${Math.round((1 - edge) * 100)}% 0px` },
    );
    // Низ страницы: верх блока может так и не дойти до нужной линии на высоком экране.
    const onScroll = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) reveal();
    };
    io.observe(el);
    if (edge !== undefined) {
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    // «На экране» — раздел, который пересекает середину окна: так в один момент
    // виден только один раздел, и кнопки соседних разделов не накладываются.
    const vis = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) el.dataset.visible = "";
        else delete el.dataset.visible;
      },
      { rootMargin: "-50% 0px -50% 0px" },
    );
    vis.observe(el);
    return () => {
      io.disconnect();
      vis.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [threshold, edge]);

  return (
    <div ref={ref} className={className} data-stagger="" data-reveal="pending">
      {children}
    </div>
  );
}
