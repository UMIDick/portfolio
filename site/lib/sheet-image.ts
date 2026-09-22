/**
 * Параметры картинок листов в карусели — общие для SheetGallery и для прогрева
 * на главной (ModelPreload): адреса должны совпадать, чтобы сработал кэш.
 */
export const CAROUSEL_SIZES = "(max-width: 640px) 85vw, 440px";
export const GRID_SIZES = "(max-width: 640px) 100vw, (max-width: 1000px) 50vw, 360px";
/** Сколько первых листов карусели грузится сразу (они видны при переходе на страницу). */
export const EAGER_SLIDES = 4;
/** SVG (заглушки) отдаём как есть — оптимизатор картинок их не обрабатывает. */
export const isUnoptimized = (src: string) => src.endsWith(".svg");
