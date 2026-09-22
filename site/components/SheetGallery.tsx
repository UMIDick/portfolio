"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRecentArrival } from "@/lib/arrival";
import { CAROUSEL_SIZES, EAGER_SLIDES, GRID_SIZES, isUnoptimized } from "@/lib/sheet-image";
import type { Sheet } from "@/lib/types";
import SheetViewer, { warmSheet } from "./SheetViewer";
import styles from "./SheetGallery.module.css";

interface Props {
  sheets: Sheet[];
  projectTitle: string;
  /** "grid" — сетка листов, "carousel" — горизонтальная лента с кнопками. */
  layout?: "grid" | "carousel";
  /** Чертежи ещё не готовы: лента размыта, листы не открываются, поверх — эта надпись. */
  locked?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Дошла ли лента до краёв. Сравниваем крайние листы с видимой областью —
 * надёжнее, чем scrollLeft, который при дробном масштабе не доходит до максимума.
 */
function trackEdges(t: HTMLElement) {
  const first = t.firstElementChild;
  const last = t.lastElementChild;
  if (!first || !last) return { start: true, end: true };
  const box = t.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(t).paddingLeft) || 0;
  return {
    start: first.getBoundingClientRect().left >= box.left + inset - 2,
    end: last.getBoundingClientRect().right <= box.right - inset + 2,
  };
}

/**
 * Сетка или карусель листов А3 + полноэкранный просмотр на нативном <dialog>.
 * Открытый лист отражается в адресе как #sheet-N, чтобы на него можно было сослаться.
 */
export default function SheetGallery({ sheets, projectTitle, layout = "grid", locked }: Props) {
  const carousel = layout === "carousel";
  const [index, setIndex] = useState<number | null>(null);
  const trackRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  // Панель с градиентным фоном (см. page.module.css): ей сообщаем положение ленты
  const panelRef = useRef<HTMLElement | null>(null);
  const trackPos = useRef(-1);
  // Пришли переходом со страницы (View Transition): листы въезжают, когда страница уже раскрылась
  const [slidesDelay] = useState(() =>
    typeof window !== "undefined" && ["proj-open", "proj-next", "proj-prev"].some(isRecentArrival) ? "1.1s" : "0.25s",
  );
  const thumbs = useRef<(HTMLElement | null)[]>([]);

  const open = useCallback((i: number) => setIndex(i), []);
  const close = useCallback(() => setIndex(null), []);
  const origin = useCallback((i: number) => thumbs.current[i] ?? null, []);

  // Открытие по ссылке вида #sheet-12
  useEffect(() => {
    const m = window.location.hash.match(/^#sheet-(\d+)$/);
    if (!m || locked) return;
    const i = sheets.findIndex((s) => s.number === Number(m[1]));
    if (i >= 0) setIndex(i);
  }, [sheets, locked]);

  // Открытый лист — в адресе (#sheet-N)
  useEffect(() => {
    if (index !== null) history.replaceState(null, "", `#sheet-${sheets[index].number}`);
    else if (window.location.hash.startsWith("#sheet-")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [index, sheets]);

  // Края ленты — не чаще раза за кадр и без перерисовки, если ничего не поменялось
  // (прокрутка шлёт десятки событий, а замер заставляет браузер пересчитать раскладку)
  const edgesFrame = useRef(0);
  const updateEdges = useCallback(() => {
    if (edgesFrame.current) return;
    edgesFrame.current = requestAnimationFrame(() => {
      edgesFrame.current = 0;
      const t = trackRef.current;
      if (!t) return;
      const next = trackEdges(t);
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
      // Доля прокрутки ленты 0…1 — градиент под листами плавно едет вместе с ними
      // (только transform на слое, без перерисовки; дробные значения ниже 0.002 не шлём)
      const range = t.scrollWidth - t.clientWidth;
      const p = range > 0 ? Math.min(1, Math.max(0, t.scrollLeft / range)) : 0;
      if (Math.abs(p - trackPos.current) >= 0.002) {
        trackPos.current = p;
        panelRef.current ??= t.closest<HTMLElement>("[data-sheets-panel]") ?? t.parentElement;
        panelRef.current?.style.setProperty("--track-p", p.toFixed(3));
      }
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(edgesFrame.current), []);

  useEffect(() => {
    if (!carousel) return;
    updateEdges();
    window.addEventListener("resize", updateEdges);
    return () => window.removeEventListener("resize", updateEdges);
  }, [carousel, updateEdges]);

  // Колесо мыши над лентой листает листы по одному. На краю ленты страница
  // не прокручивается, пока продолжается то же движение колеса, — только после паузы.
  useEffect(() => {
    const t = trackRef.current;
    if (!carousel || !t) return;
    const GESTURE_GAP = 450;
    let lockedUntil = 0;
    let lastWheel = -Infinity;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const now = performance.now();
      const sameGesture = now - lastWheel < GESTURE_GAP;
      const dir = Math.sign(e.deltaY);
      const edge = trackEdges(t);
      const atEdge = (dir < 0 && edge.start) || (dir > 0 && edge.end);
      if (atEdge) {
        if (sameGesture) {
          e.preventDefault();
          lastWheel = now;
        }
        return;
      }
      e.preventDefault();
      lastWheel = now;
      if (now < lockedUntil) return;
      lockedUntil = now + 380;
      const slide = t.firstElementChild as HTMLElement | null;
      const gap = parseFloat(getComputedStyle(t).columnGap) || 0;
      t.scrollBy({ left: dir * (slide ? slide.offsetWidth + gap : t.clientWidth), behavior: "smooth" });
    };
    t.addEventListener("wheel", onWheel, { passive: false });
    return () => t.removeEventListener("wheel", onWheel);
  }, [carousel]);

  const scrollTrack = (d: number) => {
    const t = trackRef.current;
    if (t) t.scrollBy({ left: d * t.clientWidth * 0.9, behavior: "smooth" });
  };

  const items = useMemo(
    () =>
      sheets.map((s) => ({
        key: s.number,
        src: s.src,
        width: s.width,
        height: s.height,
        title: `Лист ${pad(s.number)} · ${s.title}`,
        alt: `Лист ${s.number}. ${s.title}`,
      })),
    [sheets],
  );

  return (
    <>
      <div
        className={carousel ? styles.carousel : undefined}
        style={carousel ? ({ "--slides-delay": slidesDelay } as React.CSSProperties) : undefined}
        // inert — ни нажатий, ни фокуса с клавиатуры, ни колеса по ленте
        inert={locked ? true : undefined}
        data-locked={locked ? "" : undefined}
      >
        {locked && <p className={styles.lockedLabel}>{locked}</p>}
        <ul
          ref={carousel ? trackRef : undefined}
          className={
            carousel
              ? [styles.track, !edges.start && styles.fadeStart, !edges.end && styles.fadeEnd].filter(Boolean).join(" ")
              : styles.grid
          }
          onScroll={carousel ? updateEdges : undefined}
        >
          {sheets.map((s, i) => (
            <li
              key={s.number}
              className={carousel ? styles.slide : `${styles.item} rise`}
              style={
                carousel
                  ? ({ "--i": Math.min(i, 6) } as React.CSSProperties)
                  : { animationRange: `entry 0% entry ${30 + (i % 3) * 10}%` }
              }
            >
              <button
                type="button"
                className={styles.thumb}
                onClick={() => open(i)}
                onPointerEnter={() => warmSheet(s.src)}
                onFocus={() => warmSheet(s.src)}
                aria-label={`Лист ${s.number}. ${s.title}`}
              >
                <span className={styles.paper} ref={(el) => void (thumbs.current[i] = el)}>
                  <Image
                    src={s.src}
                    alt=""
                    width={s.width}
                    height={s.height}
                    sizes={carousel ? CAROUSEL_SIZES : GRID_SIZES}
                    unoptimized={isUnoptimized(s.src)}
                    // Первые листы карусели грузим сразу — они видны при переходе на страницу
                    loading={carousel && i < EAGER_SLIDES ? "eager" : undefined}
                  />
                </span>
                <span className={styles.caption}>
                  <span className={styles.num}>{pad(s.number)}</span>
                  <span className={styles.title}>{s.title}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {carousel && sheets.length > 1 && (
          <div className={styles.trackNav}>
            <button type="button" className={styles.iconBtn} onClick={() => scrollTrack(-1)} disabled={edges.start} aria-label="Прокрутить листы назад">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 5l-7 7 7 7" />
              </svg>
            </button>
            <button type="button" className={styles.iconBtn} onClick={() => scrollTrack(1)} disabled={edges.end} aria-label="Прокрутить листы вперёд">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

      </div>

      <SheetViewer
        items={items}
        index={index}
        onIndexChange={setIndex}
        onClose={close}
        projectTitle={projectTitle}
        origin={origin}
      />
    </>
  );
}
