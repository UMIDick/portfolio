"use client";

import { useEffect } from "react";
import { markArrival } from "@/lib/arrival";
import { markBusy } from "@/lib/idle";

/**
 * React ставит имя перехода появляющемуся элементу, только если тот в момент
 * обновления DOM виден в окне. Но прокрутка к месту назначения Next делает уже
 * после обновления — и иконка проекта «не находит пару». Поэтому для наших
 * переходов (SheetTransition) заранее, после снимка старой страницы и до
 * обновления, ставим прокрутку туда, где окажется новая страница.
 */
const TARGETS: Record<string, () => number> = {
  "proj-open": () => 0,
  "proj-next": () => 0,
  "proj-prev": () => 0,
  // Раздел «Проекты» на главной — третий экран (интро, резюме, проекты)
  "proj-close": () => window.innerHeight * 2,
};
/** Сколько длится анимация перехода (globals.css), мс: пока она идёт, фоновые шаги
    (сборка макетов, прогрев) ждут — раскрытие кругом (маска с @property) анимируется
    на главном потоке, и шаг в 50–100 мс виден как рывок. */
const DURATION: Record<string, number> = {
  "proj-open": 1300,
  "proj-next": 1000,
  "proj-prev": 1000,
  "proj-close": 1100,
};

type StartArg = ViewTransitionUpdateCallback | StartViewTransitionOptions | undefined;

export default function ViewTransitionScroll() {
  // Отмечаем, по какой ссылке ушли (data-nav) — до рендера новой страницы
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[data-nav]");
      const type = link?.getAttribute("data-nav");
      if (type) markArrival(type);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (typeof document.startViewTransition !== "function") return;
    const original = document.startViewTransition;

    document.startViewTransition = function (this: Document, arg?: StartArg) {
      const types = arg && typeof arg === "object" ? Array.from(arg.types ?? []) : [];
      const target = types.map((t) => TARGETS[t]).find(Boolean);
      if (!target || !arg || typeof arg !== "object" || !arg.update) return original.call(this, arg);

      markBusy(performance.now() + Math.max(...types.map((t) => DURATION[t] ?? 0)));
      const update = arg.update;
      const body = document.body;
      return original.call(this, {
        ...arg,
        update: async () => {
          const top = target();
          // Старая страница может быть короче новой — временно даём место для прокрутки.
          // Только когда его не хватает: смена высоты — принудительная раскладка всей страницы
          // (чтение scrollHeight само вызывает раскладку — поэтому только при прокрутке вниз)
          const grow = top > 0 && top + window.innerHeight > document.documentElement.scrollHeight;
          const prevMin = body.style.minHeight;
          if (grow) body.style.minHeight = `${top + window.innerHeight * 2}px`;
          window.scrollTo({ top, behavior: "instant" });
          try {
            const result = await update();
            // Экраны главной бывают выше окна — доводим точно до раздела «Проекты»
            if (types.includes("proj-close")) {
              const el = document.getElementById("projects");
              if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY, behavior: "instant" });
            }
            return result;
          } finally {
            if (grow) body.style.minHeight = prevMin;
          }
        },
      });
    } as typeof document.startViewTransition;

    return () => {
      document.startViewTransition = original;
    };
  }, []);

  return null;
}
