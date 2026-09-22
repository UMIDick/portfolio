/**
 * Откуда пришли на страницу: ссылка с `data-nav="…"` отмечает переход при клике
 * (см. ViewTransitionScroll). Нужна, чтобы при возврате со страницы проекта
 * карточки на главной не играли каскад появления и иконка сразу нашла свою карточку.
 */
let last: { type: string; at: number } | null = null;

/** Сколько миллисекунд отметка считается свежей (с запасом на загрузку страницы). */
const FRESH = 5000;

export function markArrival(type: string) {
  last = { type, at: Date.now() };
}

export function isRecentArrival(type: string) {
  return last !== null && last.type === type && Date.now() - last.at < FRESH;
}
