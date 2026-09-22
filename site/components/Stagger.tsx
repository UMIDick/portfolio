"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isRecentArrival } from "@/lib/arrival";
import { markBusy } from "@/lib/idle";

/* Обёртка: data-reveal="pending" → "in", когда блок впервые попал в экран (дети играют каскад через CSS);
   data-reveal="done" — содержимое сразу на местах, без каскада (см. skipAfter);
   data-visible стоит, пока блок на экране, — для элементов, которые видны только рядом с ним. */
/** Разделы, чей каскад уже сыгран (до перезагрузки страницы), — по ключу `once`. */
const played = new Set<string>();

/** Примерная длительность каскада появления раздела, мс (по умолчанию; см. busyMs). */
const CASCADE_MS = 3000;

export default function Stagger({
  className,
  children,
  threshold = 0.15,
  edge,
  skipAfter,
  busyMs = CASCADE_MS,
  once,
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
  /**
   * Тип перехода (data-nav у ссылки), после которого каскад не играет:
   * например, при возврате со страницы проекта карточки сразу стоят на местах.
   */
  skipAfter?: string;
  /** Сколько длится каскад раздела, мс: на это время фоновая подготовка откладывается. */
  busyMs?: number;
  /**
   * Ключ раздела: каскад играет только при первом просмотре. При возврате на главную
   * со страницы проекта раздел монтируется заново, но содержимое сразу на местах —
   * заново анимации проигрывает только перезагрузка страницы.
   */
  once?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Решаем при первом рендере: он происходит до снимка новой страницы в переходе
  const [initial] = useState(() =>
    typeof window !== "undefined" && ((once && played.has(once)) || (skipAfter && isRecentArrival(skipAfter)))
      ? "done"
      : "pending",
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const skip = el.dataset.reveal === "done";
    if (skip && once) played.add(once);

    const reveal = () => {
      el.dataset.reveal = "in";
      // Для общей кнопки «дальше» (NextCta): она выходит, когда каскад доиграл
      el.dataset.revealAt = String(performance.now());
      if (once) played.add(once);
      // Пока играет каскад, фоновая подготовка (прогрев видеокарты, макеты) ждёт
      // (копия раздела в слое прогрева не считается — её никто не видит)
      if (!el.closest(".gpu-warm")) markBusy(performance.now() + busyMs);
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
    if (!skip) io.observe(el);
    if (!skip && edge !== undefined) {
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
  }, [threshold, edge, busyMs, once]);

  return (
    <div ref={ref} className={className} data-stagger="" data-reveal={initial}>
      {children}
    </div>
  );
}
