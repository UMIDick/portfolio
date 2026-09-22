/**
 * Пауза до настоящего простоя браузера — для фоновой подготовки (3D-макеты, листы).
 *
 * Шаг подготовки занимает 5–40 мс, поэтому ждём, когда у браузера между кадрами
 * остаётся не меньше IDLE_MS. Пока страница непрерывно перерисовывается (вращается
 * макет на странице проекта), таких пауз не бывает — тогда шаг запускается по
 * таймауту, но только если пользователь ничего не делает: не было ввода последние
 * QUIET_MS и не идёт перелистывание экранов (ScreenPager, см. markBusy). Медленное
 * автовращение макета задержку в 30 мс не выдаёт, а прокрутка, перетаскивание
 * или наведение — выдали бы.
 *
 * quiet — для тяжёлых шагов (исполнение модуля three.js, прогрев видеокарты): их
 * нельзя начинать и в длинной паузе между кадрами, если пользователь только что
 * крутил колесо или идёт перелистывание, — шаг на сотни миллисекунд попадёт
 * ровно в анимацию.
 */
const IDLE_MS = 30;
const QUIET_MS = 700;
const TIMEOUT_MS = 1000;

let lastInput = -Infinity;
let busyUntil = 0;
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const note = () => {
    lastInput = performance.now();
  };
  for (const type of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart", "touchmove"]) {
    window.addEventListener(type, note, { passive: true, capture: true });
  }
  // Любая прокрутка, в том числе плавная по ссылке-якорю (кнопки со стрелкой): пока
  // страница едет, тяжёлые шаги ждут
  window.addEventListener("scroll", () => markBusy(performance.now() + 300), { passive: true });
}

/** Главный поток занят анимацией (например, перелистыванием экранов) до этого момента (performance.now). */
export function markBusy(untilMs: number) {
  busyUntil = Math.max(busyUntil, untilMs);
}

/** Пользователь ничего не делает и страница не анимирует ничего на главном потоке. */
export function isQuiet() {
  const now = performance.now();
  return now - lastInput > QUIET_MS && now > busyUntil;
}

/** Идёт анимация на главном потоке (перелистывание, каскад появления раздела). */
export function isBusy() {
  return performance.now() <= busyUntil;
}

/**
 * quiet — ещё и без ввода и анимаций; calm — только без анимаций (для подготовки по
 * наведению: курсор двигается, но в каскад появления карточек шаг попасть не должен).
 */
export function idlePause({ quiet = false, calm = false } = {}): Promise<void> {
  const ok = () => (!quiet || isQuiet()) && (!calm || !isBusy());
  return new Promise((resolve) => {
    listen();
    if (!("requestIdleCallback" in window)) {
      // Safari: простоя не узнать — хотя бы не во время ввода и перелистывания
      const retry = () => (ok() ? resolve() : void setTimeout(retry, 250));
      setTimeout(retry, 50);
      return;
    }
    const wait = () =>
      requestIdleCallback(
        (d) => {
          if ((d.timeRemaining() >= IDLE_MS && ok()) || (d.didTimeout && isQuiet())) resolve();
          else wait();
        },
        { timeout: TIMEOUT_MS },
      );
    wait();
  });
}
