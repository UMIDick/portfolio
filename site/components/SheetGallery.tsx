"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Sheet } from "@/lib/types";
import styles from "./SheetGallery.module.css";

interface Props {
  sheets: Sheet[];
  projectTitle: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Сетка листов А3 + полноэкранный просмотр на нативном <dialog>.
 * Открытый лист отражается в адресе как #sheet-N, чтобы на него можно было сослаться.
 */
export default function SheetGallery({ sheets, projectTitle }: Props) {
  const [index, setIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const touchX = useRef<number | null>(null);

  const open = useCallback((i: number, opener?: HTMLElement) => {
    openerRef.current = opener ?? null;
    setIndex(i);
  }, []);

  const close = useCallback(() => setIndex(null), []);

  const step = useCallback(
    (d: number) => setIndex((i) => (i === null ? i : (i + d + sheets.length) % sheets.length)),
    [sheets.length],
  );

  // Открытие по ссылке вида #sheet-12
  useEffect(() => {
    const m = window.location.hash.match(/^#sheet-(\d+)$/);
    if (!m) return;
    const i = sheets.findIndex((s) => s.number === Number(m[1]));
    if (i >= 0) setIndex(i);
  }, [sheets]);

  // Синхронизация <dialog> и адреса с состоянием
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (index === null) {
      if (dlg.open) dlg.close();
      if (window.location.hash.startsWith("#sheet-")) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      openerRef.current?.focus();
      return;
    }
    if (!dlg.open) dlg.showModal();
    history.replaceState(null, "", `#sheet-${sheets[index].number}`);
  }, [index, sheets]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(sheets.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, step, sheets.length]);

  // Предзагрузка соседних листов
  useEffect(() => {
    if (index === null) return;
    [index + 1, index - 1].forEach((i) => {
      const s = sheets[(i + sheets.length) % sheets.length];
      if (s) new window.Image().src = s.src;
    });
  }, [index, sheets]);

  const current = index === null ? null : sheets[index];

  return (
    <>
      <ul className={styles.grid}>
        {sheets.map((s, i) => (
          <li key={s.number} className={`${styles.item} rise`} style={{ animationRange: `entry 0% entry ${30 + (i % 3) * 10}%` }}>
            <button
              type="button"
              className={styles.thumb}
              onClick={(e) => open(i, e.currentTarget)}
              aria-label={`Лист ${s.number}. ${s.title}`}
            >
              <span className={styles.paper}>
                <Image
                  src={s.src}
                  alt=""
                  width={s.width}
                  height={s.height}
                  sizes="(max-width: 640px) 100vw, (max-width: 1000px) 50vw, 360px"
                  unoptimized={s.src.endsWith(".svg")}
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

      <dialog
        ref={dialogRef}
        className={styles.viewer}
        aria-label={current ? `Лист ${current.number}. ${current.title}` : "Просмотр листа"}
        onClose={close}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (el === e.currentTarget || el.dataset.close !== undefined) close();
        }}
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          touchX.current = null;
          if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1);
        }}
      >
        {current && (
          <div className={styles.viewerInner} data-close>
            <div className={styles.bar}>
              <div className={styles.barText}>
                <span className={styles.barProject}>{projectTitle}</span>
                <span className={styles.barTitle}>
                  Лист {pad(current.number)} · {current.title}
                </span>
              </div>
              <div className={styles.barRight}>
                <span className={styles.counter} aria-live="polite">
                  {index! + 1} / {sheets.length}
                </span>
                <button type="button" className={styles.iconBtn} onClick={close} aria-label="Закрыть">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className={styles.stage} data-close>
              <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => step(-1)} aria-label="Предыдущий лист">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              {/* Обычный <img>: лист меняется часто, нужен мгновенный показ без пересборки */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={current.number} src={current.src} alt={`Лист ${current.number}. ${current.title}`} className={styles.sheet} />
              <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => step(1)} aria-label="Следующий лист">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
