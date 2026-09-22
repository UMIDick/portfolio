"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styles from "./SheetViewer.module.css";

export interface ViewerItem {
  key: string | number;
  src: string;
  width: number;
  height: number;
  /** Вторая строка подписи над листом, например «Лист 03 · План кровли». */
  title: string;
  alt: string;
}

interface Props {
  items: ViewerItem[];
  /** Открытый лист; null — просмотр закрыт. */
  index: number | null;
  onIndexChange: (i: number) => void;
  /** Вызывается, когда просмотр закрылся (после анимации). */
  onClose: () => void;
  projectTitle: string;
  /**
   * Миниатюра листа на странице: из неё лист «вылетает» при открытии и в неё же
   * возвращается при закрытии. Если её нет или она вне окна — лист просто проявляется.
   */
  origin?: (i: number) => HTMLElement | null;
}

/** Приближение листа: предел, шаг кнопок/двойного клика, плавность доезда (мс). */
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.6;
const ZOOM_DOUBLE = 2.5;
const ZOOM_TAU = 70;
/** Открытие и закрытие: перелёт листа с его места на странице в центр экрана. */
const OPEN_MS = 680;
const CLOSE_MS = 620;
const OPEN_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const CLOSE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Доля перелёта при закрытии, за которую миниатюра проявляется под летящим листом. */
const LAND_REVEAL = 0.5;

/**
 * Полный размер листа — заранее, по наведению на миниатюру: к нажатию файл уже
 * в кэше, и декодирование (вне главного потока) успевает до конца перелёта.
 */
const warmed = new Set<string>();
export function warmSheet(src: string) {
  if (warmed.has(src)) return;
  warmed.add(src);
  const img = new window.Image();
  img.decoding = "async";
  img.src = src;
  img.decode().catch(() => warmed.delete(src));
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Прямоугольник миниатюры, если она видна в окне (иначе перелёт не из чего строить). */
function visibleRect(el: HTMLElement | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) return null;
  return r;
}

/**
 * Полноэкранный просмотр листа на нативном <dialog>: лист перелетает из миниатюры,
 * колесо приближает к курсору, приближенный лист тянется мышью/пальцем.
 */
export default function SheetViewer({ items, index, onIndexChange, onClose, projectTitle, origin }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closing = useRef(false);
  const backdropAnim = useRef<Animation | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const touchX = useRef<number | null>(null);
  const multiTouch = useRef(false);
  const count = items.length;
  const current = index === null ? null : items[index];

  // Приближение: текущее (s, x, y) плавно догоняет цель (ts, tx, ty). Пишем прямо в style —
  // без перерисовки React на каждый шаг колеса.
  const zoom = useRef({ s: 1, x: 0, y: 0, ts: 1, tx: 0, ty: 0, raf: 0, last: 0 });
  const [zoomed, setZoomed] = useState(false);
  // Пока лист летит из миниатюры, в нём сама миниатюра (уже декодирована): полный JPEG
  // (3000 px) декодируется ~100 мс, и главный поток ждал его посреди перелёта.
  // Полный размер подставляется после приземления
  const [flying, setFlying] = useState(false);
  const wasOpen = useRef(false);

  const applyZoom = useCallback(() => {
    const z = zoom.current;
    const img = imgRef.current;
    if (img) img.style.transform = z.s === 1 && z.x === 0 && z.y === 0 ? "" : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  }, []);

  /** Цель приближения с ограничением: лист не уезжает за край, пока он больше окна. */
  const setZoom = useCallback(
    (s: number, x: number, y: number, instant = false) => {
      const z = zoom.current;
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage || closing.current) return;
      s = Math.min(ZOOM_MAX, Math.max(1, s));
      const mx = Math.max(0, (s * img.offsetWidth - stage.clientWidth) / 2);
      const my = Math.max(0, (s * img.offsetHeight - stage.clientHeight) / 2);
      z.ts = s;
      z.tx = Math.min(mx, Math.max(-mx, x));
      z.ty = Math.min(my, Math.max(-my, y));
      // Обрезка по области листа снимается только после того, как лист вернулся к
      // исходному масштабу, — иначе при отдалении он наезжает на строку с подписью
      if (s > 1.001 || instant) setZoomed(s > 1.001);
      if (instant) {
        cancelAnimationFrame(z.raf);
        z.raf = 0;
        z.s = z.ts;
        z.x = z.tx;
        z.y = z.ty;
        applyZoom();
        return;
      }
      if (z.raf) return;
      z.last = performance.now();
      const tick = (now: number) => {
        const k = 1 - Math.exp(-(now - z.last) / ZOOM_TAU);
        z.last = now;
        z.s += (z.ts - z.s) * k;
        z.x += (z.tx - z.x) * k;
        z.y += (z.ty - z.y) * k;
        const done = Math.abs(z.ts - z.s) < 0.001 && Math.abs(z.tx - z.x) < 0.3 && Math.abs(z.ty - z.y) < 0.3;
        if (done) {
          z.s = z.ts;
          z.x = z.tx;
          z.y = z.ty;
        }
        applyZoom();
        if (done && z.s <= 1.001) setZoomed(false);
        z.raf = done ? 0 : requestAnimationFrame(tick);
      };
      z.raf = requestAnimationFrame(tick);
    },
    [applyZoom],
  );

  /** Приблизить в factor раз так, чтобы точка под курсором осталась на месте. */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number, instant = false) => {
      const z = zoom.current;
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return;
      const r = stage.getBoundingClientRect();
      const cx = r.left + img.offsetLeft + img.offsetWidth / 2;
      const cy = r.top + img.offsetTop + img.offsetHeight / 2;
      const px = clientX ?? r.left + r.width / 2;
      const py = clientY ?? r.top + r.height / 2;
      const s = Math.min(ZOOM_MAX, Math.max(1, z.ts * factor));
      const k = s / z.ts;
      setZoom(s, px - cx - k * (px - cx - z.tx), py - cy - k * (py - cy - z.ty), instant);
    },
    [setZoom],
  );

  /** Сдвиг и масштаб, которые кладут лист (его место без приближения) на прямоугольник r. */
  const flyTo = useCallback((r: DOMRect) => {
    const img = imgRef.current!;
    const stage = stageRef.current!.getBoundingClientRect();
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    const cx = stage.left + img.offsetLeft + w / 2;
    const cy = stage.top + img.offsetTop + h / 2;
    return `translate(${r.left + r.width / 2 - cx}px, ${r.top + r.height / 2 - cy}px) scale(${r.width / w}, ${r.height / h})`;
  }, []);

  // Миниатюра, из которой вылетел лист, прячется, пока он открыт: иначе за летящим
  // листом видна его копия на месте (просьба заказчика)
  const hiddenOrigin = useRef<HTMLElement | null>(null);
  const hideOrigin = useCallback((el: HTMLElement | null | undefined) => {
    if (hiddenOrigin.current === el) return;
    if (hiddenOrigin.current) hiddenOrigin.current.style.visibility = "";
    hiddenOrigin.current = el ?? null;
    if (el) el.style.visibility = "hidden";
  }, []);
  useEffect(() => {
    if (index !== null && !closing.current) hideOrigin(origin?.(index));
  }, [index, origin, hideOrigin]);
  useEffect(() => () => hideOrigin(null), [hideOrigin]);

  const fadeParts = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("[data-fade]") ?? []);

  // Открытие: до первой отрисовки, чтобы лист не мелькнул в центре раньше перелёта
  const isOpen = index !== null;
  useLayoutEffect(() => {
    const dlg = dialogRef.current;
    const img = imgRef.current;
    if (!isOpen || !dlg || !img || dlg.open) return;
    closing.current = false;
    prevFocus.current = document.activeElement as HTMLElement | null;
    backdropAnim.current?.cancel();
    dlg.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    dlg.showModal();
    // 3D-макет под просмотром на это время замирает (ProjectModel): иначе он рисуется
    // каждый кадр, и размытый фон пересчитывается на весь экран — кадры по 60–90 мс
    document.documentElement.dataset.sheetViewer = "";
    wasOpen.current = true;
    if (reducedMotion()) return;
    const from = visibleRect(origin?.(index!));
    hideOrigin(origin?.(index!));
    setFlying(true);
    img
      .animate(
        from
          ? [{ transform: flyTo(from), borderRadius: "14px" }, { transform: "none" }]
          : [{ transform: "scale(0.94)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: from ? OPEN_MS : 360, easing: OPEN_EASE },
      )
      .finished.catch(() => {})
      .then(() => setFlying(false));
    backdropAnim.current = dlg.animate(
      { opacity: [0, 1] },
      { duration: OPEN_MS * 0.8, easing: "ease", pseudoElement: "::backdrop" },
    );
    fadeParts().forEach((el) =>
      el.animate({ opacity: [0, 1] }, { duration: 360, delay: OPEN_MS * 0.5, easing: "ease", fill: "backwards" }),
    );
    // index намеренно не в зависимостях: анимация — только при открытии, не при смене листа
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, origin, flyTo, hideOrigin]);

  const finishClose = useCallback(() => {
    const dlg = dialogRef.current;
    hideOrigin(null);
    if (dlg?.open) dlg.close();
    delete document.documentElement.dataset.sheetViewer;
    wasOpen.current = false;
    closing.current = false;
    onClose();
    prevFocus.current?.focus({ preventScroll: true });
  }, [onClose, hideOrigin]);

  /** Закрытие с обратным перелётом в миниатюру (или растворением, если её не видно). */
  const close = useCallback(() => {
    const dlg = dialogRef.current;
    const img = imgRef.current;
    if (!dlg || !img || closing.current || index === null) return;
    if (reducedMotion()) return finishClose();
    closing.current = true;
    const z = zoom.current;
    cancelAnimationFrame(z.raf);
    z.raf = 0;
    const start = img.style.transform || "none";
    const to = visibleRect(origin?.(index));
    img.getAnimations().forEach((a) => a.cancel());
    const anim = img.animate(
      to
        ? // тень просмотра к миниатюре гаснет — иначе у приземлившегося листа тёмный ореол, пока его не сменит миниатюра
          [{ transform: start }, { transform: flyTo(to), borderRadius: "14px", boxShadow: "0 0 0 transparent" }]
        : [{ transform: start, opacity: 1 }, { transform: `${start === "none" ? "" : start} scale(0.94)`, opacity: 0 }],
      { duration: to ? CLOSE_MS : 280, easing: CLOSE_EASE, fill: "forwards" },
    );
    backdropAnim.current = dlg.animate(
      { opacity: [1, 0] },
      { duration: CLOSE_MS, easing: "ease", pseudoElement: "::backdrop", fill: "forwards" },
    );
    fadeParts().forEach((el) => el.animate({ opacity: [1, 0] }, { duration: 220, easing: "ease", fill: "forwards" }));
    // Миниатюра (со своей стеклянной кромкой и тенью) проявляется под летящим листом во второй
    // половине перелёта, сам лист до конца непрозрачный: к посадке под ним уже та же картинка
    // с рамкой, и подмена не видна. Растворять лист после посадки нельзя — оба полупрозрачны,
    // и картинка «тухнет»
    const el = to ? hiddenOrigin.current : null;
    if (el) {
      el.style.visibility = "";
      el.animate(
        { opacity: [0, 1] },
        { duration: CLOSE_MS * LAND_REVEAL, delay: CLOSE_MS * (1 - LAND_REVEAL), easing: "ease", fill: "backwards" },
      );
    }
    anim.onfinish = finishClose;
  }, [index, origin, flyTo, finishClose]);

  // Ушли со страницы с открытым листом — отметку для 3D-макета снимаем
  useEffect(() => () => void delete document.documentElement.dataset.sheetViewer, []);

  // Esc: вместо мгновенного закрытия диалога — анимированное
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    dlg.addEventListener("cancel", onCancel);
    return () => dlg.removeEventListener("cancel", onCancel);
  }, [close]);

  const step = useCallback(
    (d: number) => {
      if (index !== null && count > 1) onIndexChange((index + d + count) % count);
    },
    [index, count, onIndexChange],
  );

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "Home") onIndexChange(0);
      else if (e.key === "End") onIndexChange(count - 1);
      else if (e.key === "+" || e.key === "=") zoomAt(ZOOM_STEP);
      else if (e.key === "-") zoomAt(1 / ZOOM_STEP);
      else if (e.key === "0") setZoom(1, 0, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, step, count, onIndexChange, zoomAt, setZoom]);

  // Предзагрузка соседних листов
  useEffect(() => {
    if (index === null || count < 2) return;
    [index + 1, index - 1].forEach((i) => warmSheet(items[(i + count) % count].src));
  }, [index, items, count]);

  // Новый лист (или закрытие) — снова целиком
  useEffect(() => {
    const z = zoom.current;
    cancelAnimationFrame(z.raf);
    Object.assign(z, { s: 1, x: 0, y: 0, ts: 1, tx: 0, ty: 0, raf: 0 });
    applyZoom();
    setZoomed(false);
  }, [index, applyZoom]);

  // Колесо в просмотре приближает лист к курсору. Без этого прокрутка проходила
  // сквозь <dialog> и двигала страницу под ним.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (index === null || !dlg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // ctrlKey — щипок на тачпаде: шаги мелкие, нужен больший коэффициент
      zoomAt(Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX, e.clientY);
    };
    const onResize = () => {
      const z = zoom.current;
      setZoom(z.ts, z.tx, z.ty, true);
    };
    dlg.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    return () => {
      dlg.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
    };
  }, [index, zoomAt, setZoom]);

  // Перетаскивание приближенного листа мышью и пальцем, щипок двумя пальцами
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const onSheetPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onSheetPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const z = zoom.current;
    if (map.size >= 2) {
      const [a, b] = [...map.values()];
      const other = a === prev ? b : a;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0) zoomAt(after / before, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2, true);
    } else if (z.ts > 1.001) {
      setZoom(z.ts, z.tx + e.clientX - prev.x, z.ty + e.clientY - prev.y, true);
    }
    map.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onSheetPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    pointers.current.delete(e.pointerId);
  };

  // Уже загруженная миниатюра — подложка, пока грузится полный размер
  const thumb = index === null ? undefined : origin?.(index)?.querySelector("img")?.currentSrc;
  // Первая отрисовка открытого просмотра (до useLayoutEffect) — тоже ещё полёт
  const showThumb = !!thumb && (flying || (isOpen && !wasOpen.current));

  return (
    <dialog
      ref={dialogRef}
      className={styles.viewer}
      aria-label={current ? `${projectTitle}. ${current.title}` : "Просмотр листа"}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el === e.currentTarget || el.dataset.close !== undefined) close();
      }}
      onTouchStart={(e) => {
        if (e.touches.length > 1) multiTouch.current = true;
        else {
          multiTouch.current = false;
          touchX.current = e.touches[0].clientX;
        }
      }}
      onTouchEnd={(e) => {
        if (touchX.current === null || e.touches.length) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        // Свайп листает листы, только пока лист целиком (иначе палец двигает лист)
        if (multiTouch.current || zoom.current.ts > 1.001) return;
        if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1);
      }}
    >
      {current && (
        <div className={styles.viewerInner} data-close>
          <div className={styles.bar}>
            <span aria-hidden="true" />
            <div className={styles.barText} data-fade>
              <span className={styles.barProject}>{projectTitle}</span>
              <span className={styles.barTitle}>{current.title}</span>
            </div>
            <div className={styles.barRight} data-fade>
              {count > 1 && (
                <span className={styles.counter} aria-live="polite">
                  {index! + 1} / {count}
                </span>
              )}
              <button type="button" className={styles.iconBtn} onClick={close} aria-label="Закрыть">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>

          <div ref={stageRef} className={`${styles.stage} ${zoomed ? styles.stageZoomed : ""}`} data-close>
            {count > 1 && (
              <button type="button" className={`${styles.nav} ${styles.navPrev}`} onClick={() => step(-1)} aria-label="Предыдущий лист" data-fade>
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
            )}
            {/* Обычный <img>: лист меняется часто, нужен мгновенный показ без пересборки */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={current.key}
              ref={imgRef}
              src={showThumb ? thumb : current.src}
              // Полный размер загрузился — сразу декодируем его и для приближения
              onLoad={(e) => {
                if (!showThumb) e.currentTarget.decode().catch(() => {});
              }}
              width={current.width}
              height={current.height}
              // Пустой alt: пока грузится полный лист, браузер рисовал поверх
              // подложки значок и текст alt (название уже есть в подписи над листом)
              alt=""
              className={styles.sheet}
              // Лист 3000 px декодируется 60–80 мс: синхронно это кадр посреди перелёта
              // (и первого приближения). Пока он готовится, видна миниатюра-подложка
              decoding="async"
              style={
                {
                  "--ratio": current.width / current.height,
                  backgroundImage: thumb ? `url("${thumb}")` : undefined,
                } as React.CSSProperties
              }
              draggable={false}
              onPointerDown={onSheetPointerDown}
              onPointerMove={onSheetPointerMove}
              onPointerUp={onSheetPointerUp}
              onPointerCancel={onSheetPointerUp}
              onDoubleClick={(e) =>
                zoom.current.ts > 1.001 ? setZoom(1, 0, 0) : zoomAt(ZOOM_DOUBLE, e.clientX, e.clientY)
              }
            />
            {count > 1 && (
              <button type="button" className={`${styles.nav} ${styles.navNext}`} onClick={() => step(1)} aria-label="Следующий лист" data-fade>
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

/**
 * Просмотр листа «вхолостую» — для прогрева видеокарты (GpuWarmup → WarmPage): та же
 * разметка и классы (размытый фон, лист со скруглением и тенью, стеклянные кнопки)
 * и та же анимация открытия, но без <dialog>. Иначе первый просмотр листа компилировал
 * ~12 программ (165 мс) прямо во время перелёта листа. src — настоящий JPEG листа:
 * Chrome раскладывает его в YUV, и для вывода нужен свой шейдер (у WebP-миниатюр его нет).
 */
export function SheetViewerWarm({ src, thumb, width, height }: { src: string; thumb: string; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion()) return;
    const img = root.querySelector("img");
    const anims = [
      img?.animate([{ transform: "translate(-30%, 25%) scale(0.3)", borderRadius: "14px" }, { transform: "none" }], {
        duration: OPEN_MS,
        easing: OPEN_EASE,
      }),
      root.querySelector("[data-backdrop]")?.animate({ opacity: [0, 1] }, { duration: OPEN_MS * 0.8, easing: "ease" }),
      ...Array.from(root.querySelectorAll("[data-fade]")).map((el) =>
        el.animate({ opacity: [0, 1] }, { duration: 300, delay: OPEN_MS * 0.45, easing: "ease", fill: "backwards" }),
      ),
    ];
    return () => anims.forEach((a) => a?.cancel());
  }, []);
  const arrow = (d: string) => (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
  return (
    <div ref={ref} className={styles.warm}>
      <div className={styles.warmBackdrop} data-backdrop />
      <div className={`${styles.viewer} ${styles.viewerInner}`}>
        <div className={styles.bar}>
          <span />
          <div className={styles.barText} data-fade>
            <span className={styles.barProject}>Проект</span>
            <span className={styles.barTitle}>Лист 01 · План</span>
          </div>
          <div className={styles.barRight} data-fade>
            <span className={styles.counter}>1 / 2</span>
            <span className={styles.iconBtn}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </span>
          </div>
        </div>
        <div className={styles.stage}>
          <span className={`${styles.nav} ${styles.navPrev}`} data-fade>
            {arrow("M15 5l-7 7 7 7")}
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            width={width}
            height={height}
            alt=""
            className={styles.sheet}
            decoding="async"
            style={{ "--ratio": width / height, backgroundImage: `url("${thumb}")` } as React.CSSProperties}
          />
          <span className={`${styles.nav} ${styles.navNext}`} data-fade>
            {arrow("M9 5l7 7-7 7")}
          </span>
        </div>
      </div>
    </div>
  );
}
