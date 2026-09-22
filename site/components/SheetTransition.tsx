import { ViewTransition, type ReactNode } from "react";

/**
 * Переходы между страницами (View Transitions, «чертёжный лист»).
 * Тип перехода задаёт ссылка через `transitionTypes`, анимации — в globals.css.
 *  - `proj-open`  — главная → проект: карточка перелетает в иконку проекта,
 *                   главная отступает вглубь, проект раскрывается кругом от иконки;
 *  - `proj-close` — проект → главная (обратный путь);
 *  - `proj-next` / `proj-prev` — соседний проект: лист уезжает в сторону.
 */
export const NAV = {
  open: ["proj-open"],
  close: ["proj-close"],
  next: ["proj-next"],
  prev: ["proj-prev"],
};

const MAPS = {
  home: {
    enter: { "proj-close": "sheet-return", default: "none" },
    exit: { "proj-open": "sheet-recede", default: "none" },
  },
  project: {
    enter: {
      "proj-open": "sheet-open",
      "proj-close": "none",
      "proj-next": "sheet-from-right",
      "proj-prev": "sheet-from-left",
      default: "none",
    },
    exit: {
      "proj-close": "sheet-recede",
      "proj-next": "sheet-to-left",
      "proj-prev": "sheet-to-right",
      default: "none",
    },
  },
};

/** Обёртка экрана страницы: участвует в переходе целиком, одним «листом». */
export function PageSheet({ kind, children }: { kind: keyof typeof MAPS; children: ReactNode }) {
  const m = MAPS[kind];
  return (
    <ViewTransition enter={m.enter} exit={m.exit} default="none">
      {children}
    </ViewTransition>
  );
}

/** Иконка проекта — общий элемент: карточка на главной ↔ иконка на странице проекта. */
export function ProjectIcon({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <ViewTransition name={`project-icon-${slug}`} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}
