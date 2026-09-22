/**
 * Очерёдность фоновой подготовки на главной: сначала прогрев видеокарты (GpuWarmup),
 * потом 3D-макеты (ModelPreload) — чтобы их шаги не попадали в один и тот же простой.
 */
const MAX_WAIT = 9000;

/** Сколько частей у страницы «вхолостую» (WarmPage): иконка с текстом, панель, листы, второй экран. */
export const WARM_STAGES = 4;

let finish: () => void = () => {};
const done = new Promise<void>((resolve) => (finish = resolve));

/** Прогрев закончен, отменён или не нужен. */
export const gpuWarmDone = () => finish();

/** Ждёт конца прогрева, но не дольше MAX_WAIT от загрузки страницы. */
export const whenGpuWarm = () =>
  Promise.race([done, new Promise<void>((r) => setTimeout(r, Math.max(0, MAX_WAIT - performance.now())))]);
