"use client";

import { useEffect } from "react";
import { markBusy } from "@/lib/idle";

/** Совпадает с медиазапросом полноэкранной раскладки в globals.css. */
const DESKTOP = "(min-width: 761px) and (min-height: 560px)";
const DURATION = 1000;
/** Пауза в прокрутке колесом, после которой можно листать дальше. */
const QUIET = 180;
/** Через столько после остановки прокрутки адрес приводится к текущему экрану, мс. */
const HASH_DELAY = 200;

/** Положение элемента на странице без учёта transform. */
function layoutTop(el: HTMLElement) {
  let top = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
  return top;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Постраничная прокрутка экранов `[data-screen]` на всём сайте: одно движение
 * колеса или PageDown/PageUp плавно переводит к соседнему экрану.
 * Экран выше окна (например, резюме с раскрытым описанием) сначала
 * прокручивается обычным образом, и только у его края срабатывает переход.
 * Колесо, которое уже обработала карусель листов (preventDefault), не трогаем.
 *
 * Адрес следует за экраном (`#resume`, `#projects`…; у экрана без id хеш снимается):
 * иначе после кнопки «Резюме» в адресе навсегда оставался `#resume`, и перезагрузка
 * возвращала к резюме, с какого бы экрана её ни нажали. Работает и на мобильных.
 */
export default function ScreenPager() {
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let blockedUntil = 0;
    let frame = 0;

    const dialogOpen = () => !!document.querySelector("dialog[open]");

    const animateTo = (to: number) => {
      const from = window.scrollY;
      if (reduced.matches) {
        window.scrollTo({ top: to, behavior: "instant" });
        return;
      }
      const start = performance.now();
      blockedUntil = start + DURATION;
      // Прокрутка идёт на главном потоке — фоновая подготовка макетов подождёт
      markBusy(start + DURATION + 100);
      cancelAnimationFrame(frame);
      const tick = (now: number) => {
        const t = Math.min((now - start) / DURATION, 1);
        window.scrollTo({ top: from + (to - from) * ease(t), behavior: "instant" });
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    /** true — переход запущен; false — пусть браузер прокрутит сам. */
    const go = (dir: number) => {
      const list = Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"));
      if (!list.length) return false;
      const y = window.scrollY;
      const vh = window.innerHeight;
      const max = document.documentElement.scrollHeight - vh;
      const clamp = (v: number) => Math.min(Math.max(v, 0), max);
      // Для каждого экрана: где он начинается и где заканчивается (низ экрана у низа окна)
      const spans = list.map((el) => {
        const top = layoutTop(el);
        const start = clamp(top);
        return { start, end: clamp(Math.max(start, top + el.offsetHeight - vh)) };
      });
      let i = 0;
      spans.forEach((s, k) => {
        if (s.start <= y + 2) i = k;
      });
      const cur = spans[i];

      if (dir > 0) {
        if (y < cur.end - 2) return false; // высокий экран: ещё есть что прокрутить внутри
        if (i === spans.length - 1) return false;
        animateTo(spans[i + 1].start);
        return true;
      }
      if (y > cur.start + 2) {
        if (cur.end > cur.start + 2) return false; // высокий экран: сначала вверх внутри него
        animateTo(cur.start);
        return true;
      }
      if (i === 0) return false;
      animateTo(spans[i - 1].end);
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      if (!mq.matches || e.defaultPrevented || e.ctrlKey || dialogOpen()) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
      const now = performance.now();
      if (now < blockedUntil) {
        // Хвост того же движения (инерция тачпада) — гасим, пока не будет паузы
        e.preventDefault();
        blockedUntil = Math.max(blockedUntil, now + QUIET);
        return;
      }
      if (go(Math.sign(e.deltaY))) {
        e.preventDefault();
        blockedUntil = Math.max(blockedUntil, now + QUIET);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (!mq.matches || e.defaultPrevented || dialogOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === " " && el?.closest("button, a")) return;
      const down = e.key === "PageDown" || e.key === "ArrowDown" || (e.key === " " && !e.shiftKey);
      const up = e.key === "PageUp" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey);
      if (!down && !up) return;
      if (performance.now() < blockedUntil) {
        e.preventDefault();
        return;
      }
      if (go(down ? 1 : -1)) e.preventDefault();
    };

    // Ссылки-якоря на экраны (кнопка «Резюме» на обложке, кнопка со стрелкой) листают
    // тем же плавным переходом, что и колесо: у браузерной прокрутки по якорю своя,
    // более резкая кривая
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const id = (e.target as Element | null)?.closest?.('a[href^="#"]')?.getAttribute("href")?.slice(1);
      const el = id ? document.getElementById(id) : null;
      if (!el?.hasAttribute("data-screen")) return;
      e.preventDefault();
      const max = document.documentElement.scrollHeight - window.innerHeight;
      animateTo(Math.min(Math.max(layoutTop(el), 0), max));
    };

    let hashTimer = 0;
    const syncHash = () => {
      const list = Array.from(document.querySelectorAll<HTMLElement>("[data-screen]"));
      const cur = window.location.hash;
      // Чужой хеш (#sheet-N — открытый лист) не трогаем
      if (!list.length || (cur && !list.some((el) => el.id && `#${el.id}` === cur))) return;
      const mid = window.scrollY + window.innerHeight / 2;
      const el = list.find((s) => {
        const top = layoutTop(s);
        return top <= mid && mid < top + s.offsetHeight;
      });
      if (!el) return;
      const next = el.id ? `#${el.id}` : "";
      if (next !== cur) history.replaceState(null, "", window.location.pathname + window.location.search + next);
    };
    const onScroll = () => {
      clearTimeout(hashTimer);
      hashTimer = window.setTimeout(syncHash, HASH_DELAY);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(hashTimer);
      document.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
