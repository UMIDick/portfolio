"use client";

import { useEffect } from "react";
import { idlePause } from "@/lib/idle";
import { whenGpuWarm } from "@/lib/gpu-warm";
import type { ModelSource } from "./modelScene";

interface SheetPreload {
  src: string;
  srcSet?: string;
  sizes?: string;
  /** Высота к ширине. */
  ratio: number;
}

interface Source extends ModelSource {
  sheets: SheetPreload[];
}

/** Ширина листа в карусели (CAROUSEL_SIZES), px. */
const SLIDE_WIDTH = 440;
/** Раньше этого времени от загрузки (мс) подготовку не начинаем: играет интро. */
const INTRO_DONE = 3500;
/** Картинки держим, чтобы браузер не выгрузил их из кэша до перехода. */
const warmed = new Map<string, HTMLImageElement>();

/**
 * Загружает и один раз рисует лист: SVG-заглушка (текст, маска) при первой
 * отрисовке размечается и шейпится — дорого; делаем это в простое, а не во время
 * перехода на страницу проекта (навигация — в том же документе, кэш общий).
 */
async function warmSheet(s: SheetPreload) {
  if (warmed.has(s.src)) return;
  const img = new Image();
  img.decoding = "async";
  if (s.sizes) img.sizes = s.sizes;
  if (s.srcSet) img.srcset = s.srcSet;
  img.src = s.src;
  warmed.set(s.src, img);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SLIDE_WIDTH;
  canvas.height = Math.round(SLIDE_WIDTH * s.ratio);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
}

/**
 * Заранее готовит страницы проектов, чтобы переход не ждал загрузки, компиляции
 * шейдеров и первой отрисовки листов:
 *  - на компьютере — все проекты в простое браузера, когда раздел проектов рядом;
 *  - при наведении, фокусе или касании карточки — этот проект первым.
 * В режиме экономии трафика — только по наведению/касанию.
 */
export default function ModelPreload({ models }: { models: Source[] }) {
  const key = JSON.stringify(models);

  useEffect(() => {
    const list = JSON.parse(key) as Source[];
    let cancelled = false;

    const run = async (first?: string) => {
      try {
        // Модуль three.js (≈800 КБ) исполняется 40–300 мс и создаёт контекст WebGL —
        // не во время интро и только в простое, иначе это рывок
        await new Promise((r) => setTimeout(r, Math.max(0, INTRO_DONE - performance.now())));
        if (cancelled) return;
        // Прогрев видеокарты (GpuWarmup) важнее и идёт первым: без него рывки в самом
        // переходе, без макета — он лишь появится чуть позже. По наведению не ждём
        if (!first) await whenGpuWarm();
        // Только в «тихий» момент: на холодном кэше модуль исполняется сотни миллисекунд
        // По наведению не ждём тишины — но и не посреди каскада карточек: курсор после
        // прокрутки стоит как раз над въезжающей карточкой, и это ещё не намерение
        await idlePause({ quiet: !first, calm: true });
        if (cancelled) return;
        const m = await import("./modelScene");
        if (cancelled) return;
        const order = first ? [...list].sort((a, b) => +(b.slug === first) - +(a.slug === first)) : list;
        // Сначала 3D-макеты (их подготовка дольше), затем листы — по одному в простое
        await m.preloadModels(list, first);
        for (const p of order) {
          for (const s of p.sheets) {
            if (cancelled) return;
            await idlePause({ calm: true });
            await warmSheet(s).catch(() => {});
          }
        }
      } catch {
        // Без WebGL или сети — страница проекта справится сама
      }
    };

    const onIntent = (e: Event) => {
      const link = (e.target as Element | null)?.closest?.('a[data-nav="proj-open"]');
      const slug = link?.getAttribute("href")?.split("/").pop();
      if (slug && list.some((m) => m.slug === slug)) void run(slug);
    };
    document.addEventListener("pointerover", onIntent, { passive: true });
    document.addEventListener("touchstart", onIntent, { passive: true });
    document.addEventListener("focusin", onIntent);

    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    const section = document.getElementById("projects");
    let io: IntersectionObserver | null = null;
    if (section && !saveData && window.matchMedia("(pointer: fine)").matches) {
      // Раздел проектов в пределах экрана от окна — пора готовить
      io = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting) return;
          io?.disconnect();
          void run();
        },
        { rootMargin: "100% 0px" },
      );
      io.observe(section);
    }

    return () => {
      cancelled = true;
      io?.disconnect();
      document.removeEventListener("pointerover", onIntent);
      document.removeEventListener("touchstart", onIntent);
      document.removeEventListener("focusin", onIntent);
    };
  }, [key]);

  return null;
}
