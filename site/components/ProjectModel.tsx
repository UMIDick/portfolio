"use client";

import { useEffect, useRef, useState } from "react";
import type * as T from "three";
import { useRouter } from "next/navigation";
import { isRecentArrival, markArrival } from "@/lib/arrival";
import { isBusy, markBusy } from "@/lib/idle";
import type { ModelSource } from "./modelScene";
import styles from "./ProjectModel.module.css";

/**
 * 3D-макет проекта поверх иконки на странице проекта.
 *
 * Сценарий: карточка-иконка (в 3D она сначала неотличима от картинки: камера
 * строго сверху) ложится, как планшет на стол; из линий плана «печатается»
 * здание — срез поднимается снизу вверх, вдоль стен бежит светящийся контур;
 * когда здание достроено, его можно вращать мышью. Нажатие открывает макет
 * на весь экран (<dialog>, фон размыт): холст переезжает в просмотр, а карточка
 * «перелетает» со своего места в центр; повторное нажатие, Esc или крестик — обратно.
 *
 * Сцена (карточка, здание) и общий рендерер — modelScene.ts: обычно сцена уже
 * подготовлена заранее (главная, соседний проект), здесь только камера и анимации.
 * Линии (рёбра, край карточки) проявляются постепенно, пока карточка ложится, —
 * тонкие контрастные линии при наклоне камеры мерцают и выглядят как рывки.
 * Карточка-картинка остаётся в DOM: при уходе со страницы (ссылки с data-nav)
 * сцена мгновенно прячется, чтобы переход «перелёт иконки» работал как прежде.
 */

interface Props {
  slug: string;
  icon: string;
  ink: string;
  bg: string;
  /** Проекты, которые стоит подготовить заранее (соседние). */
  preload?: ModelSource[];
}

const FOV = 24;
/** Ближняя и дальняя плоскости: сцена размером меньше единицы, а точность буфера
    глубины падает от близкой ближней плоскости — совпадающие поверхности мерцают. */
const NEAR = 0.05;
const FAR = 20;
/** Наклон камеры в конце (от вертикали) и поворот вокруг здания, рад. */
const FINAL_POLAR = 0.95;
const FINAL_AZIMUTH = -0.62;

/** Если видеокарта не успевает, на время вращения и приближения кадр рисуется
    в этой доле разрешения, потом — обратно. На быстрых машинах не применяется:
    чёткость при приближении важнее (см. SLOW_FRAME). */
const INTERACT_SCALE = 0.8;
/** Кадр дольше этого (мс) — видеокарта не успевает (меньше ~45 кадров/с).
    Порог с запасом: при обычной синхронизации кадр и так 14–17 мс. */
const SLOW_FRAME = 22;
/** Столько после последнего движения макет считается «в работе», мс. */
const INTERACT_TAIL = 350;
/** Не пересоздаём буфер холста чаще (при зуме страницы размер меняется на каждый шаг), мс. */
const RESIZE_MIN_GAP = 250;
/** В покое при медленных кадрах плотность пикселей снижается до этой доли от MAX_DPR (modelScene). */
const MIN_DPR_SCALE = 0.5;
/** Минимальный интервал между кадрами, мс: на мониторах 120–165 Гц рисуем через кадр. */
const FRAME_MIN = 11.5;

/** Через столько после сборки макета готовим соседние проекты, если раньше не понадобились, мс. */
const NEIGHBOURS_AFTER = 1200;

/** Доля высоты здания, на которой тень на карточке набирает полную силу. */
const SHADOW_RAMP = 0.15;
/** Яркость светящегося контура «печати». */
const GLOW = 0.6;

const LIE_START = 250;
const LIE_TIME = 1300;
const BUILD_START = 850;
/** Готовое здание плавно переезжает из своего места на иконке в центр карточки
    (и обратно перед разборкой) — просьба заказчика. */
const CENTER_TIME = 7000;
const UNCENTER_TIME = 600;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);
/** Посадка макета на страницу: короткий разгон и долгое мягкое торможение (≈ cubic-bezier(0.4, 0, 0.1, 1)). */
const easeLand = (t: number) => {
  const x1 = 0.4;
  const x2 = 0.1;
  // x(s) = 3(1−s)²s·x1 + 3(1−s)s²·x2 + s³ — находим s по x методом Ньютона, y2 = 1, y1 = 0
  let s = t;
  for (let i = 0; i < 6; i++) {
    const x = 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s - t;
    const dx = 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    s = clamp01(s - x / dx);
  }
  return 3 * (1 - s) * s * s + s * s * s;
};

export default function ProjectModel({ slug, icon, ink, bg, preload }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fullHostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [interactive, setInteractive] = useState(false);
  const router = useRouter();
  // Список меняется по ссылке при каждом рендере страницы — эффект от него не зависит
  const preloadRef = useRef(preload);
  preloadRef.current = preload;

  useEffect(() => {
    const root = rootRef.current;
    const hit = hitRef.current;
    const stage = root?.parentElement;
    const dialog = dialogRef.current;
    const fullHost = fullHostRef.current;
    const closeBtn = closeRef.current;
    if (!root || !hit || !stage || !dialog || !fullHost || !closeBtn) return;

    let disposed = false;
    let cleanup = () => {};

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    // После перехода со страницы ждём, пока он доиграет; при обычном открытии — почти сразу
    const arrived = ["proj-open", "proj-next", "proj-prev"].some(isRecentArrival);
    let startAt = performance.now() + (reduced ? 0 : arrived ? 1150 : 350);

    // ── Уход со страницы ──
    // «← Портфолио» и кнопка «Назад» (на главную): сначала обратная анимация —
    // здание разбирается, карточка становится плоской, — затем переход с перелётом.
    // Остальные ссылки перехода: сразу возвращаем плоскую картинку.
    let reverse: (() => Promise<void>) | null = null;
    let leaving = false;
    const hideModel = () => {
      stage.dataset.model = "off";
      delete root.dataset.live;
    };
    // Кнопка «домой» внизу страницы: сначала страница плавно поднимается к макету
    // (та же длительность и кривая, что у ScreenPager), потом всё как у «← Портфолио»
    const scrollToTop = () =>
      new Promise<void>((done) => {
        const from = window.scrollY;
        if (from <= 0 || reduced) {
          window.scrollTo({ top: 0, behavior: "instant" });
          return done();
        }
        const start = performance.now();
        markBusy(start + 1100);
        const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
        const tick = (now: number) => {
          const t = Math.min((now - start) / 1000, 1);
          window.scrollTo({ top: from * (1 - ease(t)), behavior: "instant" });
          if (t < 1) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
    const leaveToHome = async (href: string, fromHistory: boolean, type = "proj-close", toTop = false) => {
      leaving = true;
      if (toTop) await scrollToTop();
      if (reverse) await reverse();
      hideModel();
      // Отметку ставим после разборки — иначе к приходу на страницу она устареет
      markArrival(type);
      // Кадр на отрисовку плоской картинки — её снимет переход
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (fromHistory) router.replace(href, { scroll: false, transitionTypes: [type] });
      else router.push(href, { transitionTypes: [type] });
    };
    const onNavClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[data-nav]");
      if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const nav = link.getAttribute("data-nav") ?? "";
      // На главную и к соседнему проекту — сначала обратная анимация макета
      if (nav === "proj-close" || nav === "proj-next" || nav === "proj-prev") {
        // Не даём Link уйти сразу
        e.preventDefault();
        e.stopPropagation();
        if (!leaving) void leaveToHome(link.getAttribute("href") ?? "/", false, nav, link.hasAttribute("data-scroll-top"));
      } else hideModel();
    };
    // Кнопка «Назад»: адрес уже сменился на главную — перехватываем до роутера Next
    // и уходим через replace. Слушатели popstate вызываются по порядку регистрации,
    // поэтому ловим событие через хук из app/layout.tsx, поставленный раньше Next.
    const onPopState = (e: PopStateEvent) => {
      if (leaving || window.location.pathname !== "/" || !e.state?.__NA) return;
      e.stopImmediatePropagation();
      void leaveToHome(window.location.pathname + window.location.search + window.location.hash, true);
    };
    const hooks = window as unknown as { __popstateHook?: (e: PopStateEvent) => void };
    document.addEventListener("click", onNavClick, true);
    hooks.__popstateHook = onPopState;

    (async () => {
      const mod = await import("./modelScene");
      if (disposed) return;
      const src = { slug, icon, ink, bg };
      // После перехода собирать сцену с нуля начинаем, только когда анимация
      // страницы доиграла (обычно сцена уже готова — её подготовила главная)
      if (arrived && !reduced && !mod.isPreparing(slug)) {
        await new Promise((r) => setTimeout(r, Math.max(0, startAt - 150 - performance.now())));
        // …и не раньше конца самого перехода (ViewTransitionScroll → markBusy)
        while (isBusy() && !disposed) await new Promise((r) => setTimeout(r, 50));
        if (disposed) return;
      }
      const model = await mod.prepareModel(src, { urgent: true });
      if (disposed) return;
      // Сборка могла занять время — анимация начинается с начала, а не с середины
      startAt = Math.max(startAt, performance.now() + 30);

      const { THREE, OrbitControls } = mod;
      const { Vector3, Spherical } = THREE;
      const { renderer, canvas } = mod.getRenderer();
      const { scene, building, clip, scan, scanMat, totalH, baseH, roofOutline, setLabels, setPlate, setLineDetail, setLineFade, setShadowStrength, setCutaway } = model;
      model.reset();
      canvas.className = styles.canvas;
      root.appendChild(canvas);

      // Плотность пикселей: не выше MAX_DPR (в полноэкранном просмотре — MAX_DPR_FULL),
      // ниже при движении макета и при медленных кадрах в покое (см. adaptDpr)
      let dprScale = 1;
      let slowSum = 0;
      let slowCount = 0;
      let adaptBlockUntil = 0;
      let interactUntil = 0;
      /** Скользящее среднее длительности кадра — по нему решаем, нужно ли упрощать. */
      let avgFrame = 0;
      const interacting = () => performance.now() < interactUntil;
      const lowRes = () => isFull() && interacting() && avgFrame > SLOW_FRAME;
      const pixelRatio = () =>
        Math.min(window.devicePixelRatio, mod.MAX_DPR) * dprScale * (lowRes() ? INTERACT_SCALE : 1);
      renderer.shadowMap.needsUpdate = true;

      const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);


      const buildTime = reduced ? 0 : model.buildMs;

      // ── Камера ──
      // Центр вращения — центр карточки. Сдвиг кадра (setViewOffset) держит его
      // в заданной точке холста («рамка» карточки): на странице — ровно в центре
      // исходной иконки, поэтому карточка не «уезжает» с места.
      type Pose = { radius: number; polar: number; azimuth: number };
      /** Центр и сторона карточки на холсте, px. */
      type Frame = { cx: number; cy: number; size: number };
      const origin = new Vector3(0, 0, 0);
      /** Точка, вокруг которой вращается камера: центр карточки, в полноэкранном
          просмотре её сдвигает перемещение с зажатым колесиком (панорама). */
      const pivot = new Vector3(0, 0, 0);
      /** Куда плавно доезжает pivot за шагом мыши. */
      const panTo = new Vector3(0, 0, 0);
      const fromPivot = () => camera.position.clone().sub(pivot);
      const tanHalf = Math.tan((FOV * Math.PI) / 360);
      let cw = 1;
      let ch = 1;
      let frame: Frame = { cx: 0, cy: 0, size: 1 };
      let topPose!: Pose;
      let finalPose!: Pose;

      const placeCamera = (cam: T.PerspectiveCamera, p: Pose, center: T.Vector3 = pivot) => {
        cam.position.setFromSpherical(new Spherical(p.radius, p.polar, p.azimuth)).add(center);
        cam.lookAt(center);
      };
      const setRadius = (radius: number) => {
        const s = new Spherical().setFromVector3(fromPivot());
        placeCamera(camera, { radius, polar: s.phi, azimuth: s.theta });
      };
      const applyOffset = (cam: T.PerspectiveCamera, w: number, h: number, f: Frame) => {
        cam.aspect = w / h;
        cam.setViewOffset(w, h, w / 2 - f.cx, h / 2 - f.cy, w, h);
        cam.updateProjectionMatrix();
      };
      /** Кадр нужно перерисовать (в покое рисуем только при изменениях). */
      let dirty = true;
      const setFrame = (f: Frame) => {
        frame = f;
        dirty = true;
        applyOffset(camera, cw, ch, f);
        // Размер карточки на экране (в полноэкранном просмотре рамка заведомо больше экрана)
        setLineDetail(Math.min(f.size, Math.max(cw, ch)));
      };

      // Сверху: 1 единица сцены = стороне карточки в пикселях — картинка и 3D совпадают
      const topRadius = (h: number, f: Frame) => h / f.size / (2 * tanHalf);

      // Сдвиг, ставящий здание центром (по габаритам самой геометрии) в центр карточки
      building.position.set(0, 0, 0);
      building.updateMatrixWorld(true);
      const bbox = new THREE.Box3().setFromObject(building);
      const centerShift = bbox.isEmpty()
        ? new Vector3()
        : new Vector3(-(bbox.min.x + bbox.max.x) / 2, 0, -(bbox.min.z + bbox.max.z) / 2);
      let centerK = 0;
      let centerFrom = 0;
      const setCenter = (k: number) => {
        centerK = k;
        building.position.copy(centerShift).multiplyScalar(k);
        renderer.shadowMap.needsUpdate = true;
      };

      // В конце: тот же масштаб карточки; камера отходит, только если здание не влезает
      // Верх здания для вписывания: контур перекрытия (точнее габаритов плана)
      const fitRadius = (w: number, h: number, f: Frame, margin: number) => {
        const pts = [
          ...[
            [-0.5, 0, -0.5],
            [0.5, 0, -0.5],
            [-0.5, 0, 0.5],
            [0.5, 0, 0.5],
            [-0.5, -mod.CARD_DEPTH, 0.5],
            [0.5, -mod.CARD_DEPTH, 0.5],
          ].map(([x, y, z]) => ({ p: new Vector3(x, y, z), lim: 0.99 * margin })),
          ...roofOutline.map(([x, z]) => ({ p: new Vector3(x, totalH, z), lim: 0.95 * margin })),
          // Здание после переезда в центр тоже должно влезать
          ...(bbox.isEmpty() ? [] : [[bbox.min.x, bbox.min.z], [bbox.max.x, bbox.min.z], [bbox.min.x, bbox.max.z], [bbox.max.x, bbox.max.z]]).map(
            ([x, z]) => ({ p: new Vector3(x, totalH, z).add(centerShift), lim: 0.95 * margin }),
          ),
        ];
        const probe = new THREE.PerspectiveCamera(FOV, w / h, NEAR, FAR);
        applyOffset(probe, w, h, f);
        const fits = (radius: number) => {
          placeCamera(probe, { radius, polar: FINAL_POLAR, azimuth: FINAL_AZIMUTH }, origin);
          probe.updateMatrixWorld();
          return pts.every(({ p, lim }) => {
            const v = p.clone().project(probe);
            // Точка за камерой проецируется «внутрь» — такое положение не подходит
            return v.z > -1 && v.z < 1 && Math.abs(v.x) <= lim && Math.abs(v.y) <= lim;
          });
        };
        let lo = topRadius(h, f);
        if (fits(lo)) return lo;
        let hi = lo * 2;
        while (!fits(hi) && hi < lo * 1e4) hi *= 2;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) hi = mid;
          else lo = mid;
        }
        return hi;
      };

      // ── Где стоит холст: на странице (root) или в полноэкранном просмотре ──
      let host: HTMLElement = root;
      const isFull = () => host === fullHost;
      const inlineFrame = (): Frame => ({
        cx: -root.offsetLeft + stage.clientWidth / 2,
        cy: -root.offsetTop + stage.clientHeight / 2,
        size: stage.clientWidth,
      });
      // Карточка на весь экран: по центру и как можно крупнее — заданный размер
      // заведомо больше экрана, камера отходит ровно настолько, чтобы макет влез
      const fullFrame = (w: number, h: number): Frame => ({ cx: w / 2, cy: h / 2, size: Math.max(w, h) * 3 });
      const FULL_MARGIN = 0.97;
      /** Пределы приближения колесом в полноэкранном просмотре (от вписанного расстояния). */
      const ZOOM_IN = 0.3;
      const ZOOM_OUT = 1.6;
      /** За сколько миллисекунд приближение доезжает до нового шага колеса. */
      const ZOOM_EASE = 170;
      /** Во сколько раз камера дальше вписанного расстояния: сейчас и куда едет. */
      let zoomFactor = 1;
      let zoomTo = 1;
      let zoomOn = false;
      const setZoom = (on: boolean) => {
        zoomOn = on;
        if (!on) zoomFactor = zoomTo = 1;
        if (!controls) return;
        // Приближение ведём сами (плавно), OrbitControls меняет расстояние рывком
        // и делает это мимо цикла — кадр тогда обновляется только при вращении
        controls.enableZoom = false;
        controls.minDistance = on ? finalPose.radius * ZOOM_IN : 0;
        controls.maxDistance = on ? finalPose.radius * ZOOM_OUT : Infinity;
      };

      let controls: InstanceType<typeof OrbitControls> | null = null;
      let phase: "intro" | "idle" | "outro" = "intro";
      let autoAzimuth = FINAL_AZIMUTH;
      let autoPolar = FINAL_POLAR;

      // Пересоздание буфера холста — заметная пауза (с MSAA тем более), поэтому
      // при частых изменениях (зум страницы, перетаскивание окна) оно откладывается:
      // пока рисуем прежним буфером, а точный размер ставим, когда изменения улягутся.
      let lastResize = 0;
      let settleTimer = 0;
      let sizedLowRes = false;
      /** До этого момента буфер не трогаем: макет садится на страницу (см. closeFull). */
      let holdSizeUntil = 0;
      const applySize = (force = false) => {
        const now = performance.now();
        clearTimeout(settleTimer);
        if (now < holdSizeUntil) {
          settleTimer = window.setTimeout(() => applySize(true), holdSizeUntil - now);
          dirty = true;
          return;
        }
        if (!force && now - lastResize < RESIZE_MIN_GAP) {
          settleTimer = window.setTimeout(() => applySize(true), RESIZE_MIN_GAP);
          dirty = true;
          return;
        }
        lastResize = now;
        sizedLowRes = lowRes();
        mod.sizeCanvas(cw, ch, pixelRatio());
        dirty = true;
        // Первые кадры после пересоздания буфера всегда медленные — по ним не судим
        slowSum = slowCount = 0;
        adaptBlockUntil = now + 400;
      };
      /** Начали вращать или приближать — на время движения рисуем мельче. */
      const markInteract = () => {
        const was = lowRes();
        interactUntil = performance.now() + INTERACT_TAIL;
        if (!was && lowRes()) applySize(true);
      };
      // Колесо (приближение) и перетаскивание: OrbitControls шлёт start/end сразу,
      // поэтому «в работе» держим по таймеру. Слушаем оба места, где живёт холст.
      const onDrag = (e: PointerEvent) => {
        if (e.buttons) markInteract();
      };
      for (const el of [hit, fullHost]) {
        el.addEventListener("wheel", markInteract, { passive: true });
        el.addEventListener("pointermove", onDrag, { passive: true });
      }

      const layout = () => {
        cw = Math.max(1, host.clientWidth);
        ch = Math.max(1, host.clientHeight);
        applySize();
        // Во время перелёта рамку и расстояние ведёт анимация
        if (morph) return;
        setFrame(isFull() ? fullFrame(cw, ch) : inlineFrame());
        topPose = { radius: topRadius(ch, frame), polar: 0.0005, azimuth: 0 };
        finalPose = {
          radius: fitRadius(cw, ch, frame, isFull() ? FULL_MARGIN : 1),
          polar: FINAL_POLAR,
          azimuth: FINAL_AZIMUTH,
        };
        if (phase === "idle") {
          // После сборки сохраняем угол обзора и приближение, подгоняем расстояние
          setRadius(finalPose.radius * zoomFactor);
          if (isFull()) setZoom(true);
          controls?.update();
        }
      };

      // ── Перелёт карточки между страницей и полноэкранным просмотром ──
      const MORPH_TIME = 750;
      /** Обратный перелёт дольше и с мягкой посадкой (easeLand) — заказчику закрытие казалось резким. */
      const LAND_TIME = 1000;
      /** Столько после посадки рисуем прежним (полноэкранным) буфером: пересоздание буфера —
          кадр в 70–120 мс, в момент приземления он читался как рывок. */
      const LAND_HOLD = 700;
      let morph: {
        start: number;
        from: Frame;
        to: Frame;
        r0: number;
        r1: number;
        land: boolean;
        /** Наклон камеры в начале посадки: к концу возвращается к исходному (FINAL_POLAR). */
        polar0: number;
        /** Сдвиг панорамы в начале: к концу посадки — обратно в центр карточки. */
        pivot0: T.Vector3;
        done: () => void;
      } | null = null;
      /** Автовращение после закрытия просмотра набирает скорость плавно (начало разгона, мс; 0 — не идёт). */
      let spinFrom = 0;
      const SPIN_SPEED = 0.9;
      const SPIN_RAMP = 1800;
      let closing: Promise<void> | null = null;

      const startMorph = (to: Frame, r1: number, land = false) =>
        new Promise<void>((done) => {
          const r0 = fromPivot().length();
          const polar0 = new Spherical().setFromVector3(fromPivot()).phi;
          morph = { start: performance.now(), from: frame, to, r0, r1, land, polar0, pivot0: pivot.clone(), done };
        });

      const stageRect = (): Frame => {
        const r = stage.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: r.width };
      };

      const useControlsOn = (el: HTMLElement | null) => {
        if (!controls) return;
        controls.disconnect();
        if (el) controls.connect(el);
      };

      let openedByKey = false;
      const openFull = (byKey = false) => {
        if (phase !== "idle" || isFull() || closing || dialog.open) return;
        openedByKey = byKey;
        // Размер на экране ∝ высота холста / расстояние: пересчитываем расстояние
        // под новый холст, чтобы в первый кадр карточка осталась той же
        dialog.showModal();
        const r0 = (fromPivot().length() * (fullHost.clientHeight || window.innerHeight)) / ch;
        host = fullHost;
        fullHost.appendChild(canvas);
        layout(); // cw/ch и позы — уже для полноэкранного холста
        const to = frame;
        const r1 = finalPose.radius;
        setFrame(stageRect());
        setRadius(r0);
        renderer.render(scene, camera);
        requestAnimationFrame(() => (dialog.dataset.open = ""));

        if (!controls) {
          // Сенсорные экраны: на весь экран макет можно вращать пальцем
          controls = makeControls(fullHost);
          controls.autoRotate = !reduced;
        } else useControlsOn(fullHost);
        // Колесо приближает только после перелёта
        void startMorph(to, r1).then(() => {
          if (isFull() && !closing) setZoom(true);
        });
      };

      const closeFull = () => {
        if (!isFull()) return Promise.resolve();
        if (closing) return closing;
        delete dialog.dataset.open;
        setZoom(false);
        // Макет возвращается в исходный наклон и снова медленно крутится — вращение
        // набирает скорость с нуля ещё в полёте, без рывка после посадки
        if (controls && !reduced) {
          controls.autoRotateSpeed = 0;
          controls.autoRotate = true;
          spinFrom = performance.now();
        }
        closing = (async () => {
          // Куда вернуться: карточка на странице и её расстояние в масштабе полноэкранного холста
          const inlineH = Math.max(1, root.clientHeight);
          const rInline = fitRadius(Math.max(1, root.clientWidth), inlineH, inlineFrame(), 1);
          morph = null;
          await startMorph(stageRect(), (rInline * ch) / inlineH, true);
          // Буфер холста остаётся полноэкранным ещё LAND_HOLD (холст растянут по месту,
          // пропорции задаёт камера) — точный размер ставим, когда макет уже стоит
          holdSizeUntil = performance.now() + LAND_HOLD;
          host = root;
          root.appendChild(canvas);
          layout();
          if (finePointer) useControlsOn(hit);
          else if (controls) {
            // Сенсорные: на странице — снова медленное вращение с текущего ракурса
            const s = new Spherical().setFromVector3(fromPivot());
            autoAzimuth = s.theta;
            autoPolar = s.phi;
            controls.dispose();
            controls = null;
          }
          renderer.render(scene, camera);
          dialog.close();
          closing = null;
          // Фокус возвращаем только тем, кто открывал с клавиатуры, — иначе вокруг макета рамка
          if (openedByKey) hit.focus({ preventScroll: true });
          else hit.blur();
        })();
        return closing;
      };

      const makeControls = (el: HTMLElement) => {
        const c = new OrbitControls(camera, el);
        c.target.copy(pivot);
        // Колесико (средняя кнопка) — наша панорама (onPanDown), правая ничего не делает
        c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: null, RIGHT: null };
        c.enableDamping = true;
        c.dampingFactor = 0.08;
        c.enableZoom = false;
        c.enablePan = false;
        c.rotateSpeed = 0.75;
        c.minPolarAngle = 0.2;
        c.maxPolarAngle = 1.4;
        c.autoRotate = !reduced;
        c.autoRotateSpeed = SPIN_SPEED;
        c.addEventListener("start", () => {
          c.autoRotate = false;
          markInteract();
        });
        c.update();
        return c;
      };

      // Нажатие без перетаскивания: на странице — открыть, в просмотре — закрыть
      const onTap = (el: HTMLElement, action: () => void) => {
        let down: { x: number; y: number; t: number; auto: boolean } | null = null;
        const onDown = (e: PointerEvent) => {
          if (e.button !== 0) return;
          // Второй палец (щипок) — это не нажатие
          if (down) {
            down = null;
            return;
          }
          down = { x: e.clientX, y: e.clientY, t: performance.now(), auto: controls?.autoRotate ?? false };
        };
        const onUp = (e: PointerEvent) => {
          const d = down;
          down = null;
          if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return;
          // Нажатие не считается «вращением» — возвращаем автоповорот
          if (controls) controls.autoRotate = d.auto;
          action();
        };
        const onCancel = () => (down = null);
        // capture — раньше OrbitControls, который выключает автоповорот на pointerdown
        el.addEventListener("pointerdown", onDown, true);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onCancel);
        return () => {
          el.removeEventListener("pointerdown", onDown, true);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("pointercancel", onCancel);
        };
      };
      const offTapInline = onTap(hit, () => openFull());
      const offTapFull = onTap(fullHost, () => void closeFull());
      const onHitKey = (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openFull(true);
      };
      hit.addEventListener("keydown", onHitKey);
      const onCancelDialog = (e: Event) => {
        // Esc: закрываем с анимацией, а не мгновенно
        e.preventDefault();
        void closeFull();
      };
      dialog.addEventListener("cancel", onCancelDialog);
      const onCloseBtn = () => void closeFull();
      closeBtn.addEventListener("click", onCloseBtn);
      // Колесо над просмотром не прокручивает страницу под ним, а плавно приближает
      const onDialogWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (!zoomOn || morph) return;
        // Шаг колеса — множитель расстояния; строки и страницы приводим к пикселям
        const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * ch : e.deltaY;
        zoomTo = Math.min(ZOOM_OUT, Math.max(ZOOM_IN, zoomTo * Math.exp(px * 0.0011)));
        dirty = true;
      };
      dialog.addEventListener("wheel", onDialogWheel, { passive: false });

      // Перемещение с зажатым колесиком (как в Revit): точка вращения едет вслед за
      // мышью в плоскости экрана, камера — вместе с ней; доезд плавный (PAN_EASE)
      const PAN_EASE = 110;
      let panFrom: { x: number; y: number; id: number } | null = null;
      const onPanDown = (e: PointerEvent) => {
        if (e.button !== 1 || !zoomOn || morph) return;
        e.preventDefault(); // без автопрокрутки браузера
        panFrom = { x: e.clientX, y: e.clientY, id: e.pointerId };
        fullHost.setPointerCapture(e.pointerId);
        if (controls) controls.autoRotate = false;
        fullHost.dataset.panning = "";
        markInteract();
      };
      // Сдвиг точки вращения на dx/dy пикселей экрана — общий для мыши и двух пальцев
      const panBy = (dx: number, dy: number) => {
        // Пиксель экрана → единицы сцены на расстоянии точки вращения
        const k = (2 * fromPivot().length() * tanHalf) / ch;
        camera.updateMatrixWorld();
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        panTo.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
        // Дальше краёв карточки и выше здания не уводим — макет не потеряется
        panTo.set(
          Math.min(0.5, Math.max(-0.5, panTo.x)),
          Math.min(totalH, Math.max(0, panTo.y)),
          Math.min(0.5, Math.max(-0.5, panTo.z)),
        );
        dirty = true;
        markInteract();
      };
      const onPanMove = (e: PointerEvent) => {
        if (!panFrom || e.pointerId !== panFrom.id) return;
        const dx = e.clientX - panFrom.x;
        const dy = e.clientY - panFrom.y;
        panFrom.x = e.clientX;
        panFrom.y = e.clientY;
        panBy(dx, dy);
      };
      const onPanUp = (e: PointerEvent) => {
        if (!panFrom || e.pointerId !== panFrom.id) return;
        panFrom = null;
        delete fullHost.dataset.panning;
        if (fullHost.hasPointerCapture(e.pointerId)) fullHost.releasePointerCapture(e.pointerId);
      };
      // Автопрокрутка по колесику включается на mousedown — гасим и её
      const onMiddleMouse = (e: MouseEvent) => {
        if (e.button === 1) e.preventDefault();
      };
      fullHost.addEventListener("pointerdown", onPanDown);
      fullHost.addEventListener("pointermove", onPanMove);
      fullHost.addEventListener("pointerup", onPanUp);
      fullHost.addEventListener("pointercancel", onPanUp);
      fullHost.addEventListener("mousedown", onMiddleMouse);
      fullHost.addEventListener("auxclick", onMiddleMouse);

      // Два пальца на сенсорном экране — как мышь на ПК: щипок приближает (колесо),
      // движение обоих пальцев вместе перемещает (панорама с зажатым колесиком).
      // OrbitControls двумя пальцами сам ничего не делает: dolly и pan у него выключены.
      const touches = new Map<number, { x: number; y: number }>();
      let pinchDist = 0;
      let pinchMid = { x: 0, y: 0 };
      const onPinchDown = (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const [a, b] = [...touches.values()];
          pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
          pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (controls) controls.autoRotate = false;
          markInteract();
        }
      };
      const onPinchMove = (e: PointerEvent) => {
        const t = touches.get(e.pointerId);
        if (!t) return;
        t.x = e.clientX;
        t.y = e.clientY;
        if (touches.size !== 2 || !zoomOn || morph) return;
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinchDist > 0 && d > 0) {
          zoomTo = Math.min(ZOOM_OUT, Math.max(ZOOM_IN, zoomTo * (pinchDist / d)));
          dirty = true;
          markInteract();
        }
        panBy(mid.x - pinchMid.x, mid.y - pinchMid.y);
        pinchDist = d;
        pinchMid = mid;
      };
      const onPinchUp = (e: PointerEvent) => {
        touches.delete(e.pointerId);
        pinchDist = 0;
      };
      fullHost.addEventListener("pointerdown", onPinchDown);
      fullHost.addEventListener("pointermove", onPinchMove);
      fullHost.addEventListener("pointerup", onPinchUp);
      fullHost.addEventListener("pointercancel", onPinchUp);

      layout();
      placeCamera(camera, topPose);
      clip.constant = reduced ? totalH + 1 : -0.001;

      // ── Цикл ──
      let raf = 0;
      let visible = true;
      let shown = false;
      let lastNow = performance.now();

      let shadowTick = 0;
      let preloadTimer = 0;
      let wantNeighbours = false;
      const preloadNeighbours = () => {
        const next = preloadRef.current;
        if (!wantNeighbours || !next?.length) return;
        wantNeighbours = false;
        clearTimeout(preloadTimer);
        document.removeEventListener("pointerover", onNeighbourIntent);
        document.removeEventListener("focusin", onNeighbourIntent);
        void mod.preloadModels(next);
      };
      const onNeighbourIntent = (e: Event) => {
        if ((e.target as Element | null)?.closest?.('a[data-nav="proj-next"], a[data-nav="proj-prev"]')) preloadNeighbours();
      };
      document.addEventListener("pointerover", onNeighbourIntent, { passive: true });
      document.addEventListener("focusin", onNeighbourIntent);
      const setBuild = (h: number, glow: number) => {
        clip.constant = h <= 0 ? -0.001 : h + 0.0005;
        // Пока здание низкое — карту теней не трогаем: срез почти лежит на карточке,
        // и тень от него сама на себя идёт рябью. Дальше — раз в три кадра
        // (на глаз не заметно, а кадр заметно легче).
        const lowBuild = h < totalH * SHADOW_RAMP;
        if (h <= 0 || (!lowBuild && (++shadowTick % 3 === 0 || h >= totalH))) renderer.shadowMap.needsUpdate = true;
        scan.position.y = Math.max(0, Math.min(h, totalH));
        setShadowStrength(h / (totalH * SHADOW_RAMP));
        // Контур мягче: яркая тонкая линия на наклонной карточке мерцает
        scanMat.opacity = glow * GLOW;
      };

      const finishIntro = () => {
        phase = "idle";
        setBuild(totalH + 1, 0);
        renderer.shadowMap.needsUpdate = true;
        setLabels(0);
        setPlate(0);
        setLineFade(1);
        // Здание готово — срез больше не виден, изнанку можно не рисовать
        setCutaway(false);
        placeCamera(camera, finalPose);
        centerFrom = reduced ? 0 : performance.now();
        if (reduced) setCenter(1);
        if (finePointer) controls = makeControls(hit);
        setInteractive(true);
        // Соседние проекты — в фоне, чтобы переход к ним тоже был плавным: сразу, если макет
        // ушёл из окна (второй экран, где ссылки на соседей) или навели на ссылку соседа,
        // иначе через NEIGHBOURS_AFTER. Не ждём дольше: неготовый макет при переходе
        // собирается с компиляцией шейдеров — кадры по 150–200 мс у нового посетителя
        wantNeighbours = true;
        if (!visible) preloadNeighbours();
        else preloadTimer = window.setTimeout(preloadNeighbours, NEIGHBOURS_AFTER);
      };

      // ── Обратная анимация: здание разбирается, карточка поднимается в 2D ──
      const OUTRO_UNBUILD = 750;
      const OUTRO_CAMERA = 900;
      const OUTRO_TOTAL = 1250;
      let outro: { start: number; from: Pose; h0: number; c0: number; done: () => void } | null = null;

      const playOutro = () =>
        new Promise<void>((resolve) => {
          if (controls) controls.enabled = false;
          setInteractive(false);
          const s = new Spherical().setFromVector3(fromPivot());
          // К ближайшему «нулевому» углу, без лишнего оборота
          const azimuth = Math.atan2(Math.sin(s.theta), Math.cos(s.theta));
          setCutaway(true);
          const h0 = phase === "intro" ? Math.max(0, clip.constant) : totalH;

          phase = "outro";
          centerFrom = 0;
          outro = { start: performance.now(), from: { radius: s.radius, polar: s.phi, azimuth }, h0, c0: centerK, done: resolve };
        });

      const html = document.documentElement;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        // Поверх открыт лист на весь экран (SheetViewer): макет под размытием не виден,
        // а каждый его кадр заставлял пересчитывать размытие всего экрана. Замираем
        // и после закрытия продолжаем с того же места
        if (phase === "idle" && !isFull() && html.dataset.sheetViewer !== undefined) {
          lastNow = now;
          return;
        }
        if (now - lastNow < FRAME_MIN) return;
        const rawDt = now - lastNow;
        const dt = Math.min(rawDt, 64);
        lastNow = now;
        if (rawDt < 500) avgFrame = avgFrame ? avgFrame * 0.9 + rawDt * 0.1 : rawDt;
        const t = now - startAt;
        if (t < 0) return;

        if (!shown) {
          shown = true;
          root.dataset.live = "";
          stage.dataset.model = "on";
        }

        if (phase === "intro") {
          const lie = reduced ? 1 : easeInOut(clamp01((t - LIE_START) / LIE_TIME));
          placeCamera(camera, {
            radius: topPose.radius + (finalPose.radius - topPose.radius) * lie,
            polar: topPose.polar + (finalPose.polar - topPose.polar) * lie,
            azimuth: topPose.azimuth + (finalPose.azimuth - topPose.azimuth) * lie,
          });
          // Надписи гаснут в первой половине «укладки»
          setLabels(reduced ? 0 : 1 - easeInOut(clamp01((t - LIE_START) / (LIE_TIME * 0.5))));
          const b = buildTime ? clamp01((t - BUILD_START) / buildTime) : 1;
          // Контур вспыхивает на старте и гаснет к концу сборки
          const glow = b <= 0 ? 0 : b < 1 ? Math.min(1, b * 8) * (1 - easeOut(Math.max(0, (b - 0.8) / 0.2))) : 0;
          // Здание растёт от пола 1-го этажа: ниже — фундаментная плита, внутри
          // которой секущая плоскость показывала бы её изнанку
          setBuild(b > 0 ? baseH + easeInOut(b) * (totalH - baseH) : 0, glow);
          // Рисунок плана на карточке уходит, как только пошла «печать»: дальше
          // здание стоит на чистой карточке, а не поверх собственного плана
          setPlate(reduced ? 0 : 1 - easeInOut(clamp01(b / 0.18)));
          // Рёбра и край карточки проявляются, пока карточка ложится и здание растёт
          setLineFade(reduced ? 1 : easeInOut(clamp01((t - LIE_START - LIE_TIME * 0.35) / (LIE_TIME * 0.65 + buildTime * 0.5))));
          if (lie >= 1 && b >= 1) finishIntro();
        } else if (phase === "idle") {
          if (centerFrom) {
            const k = clamp01((now - centerFrom) / CENTER_TIME);
            setCenter(easeInOut(k));
            if (k >= 1) centerFrom = 0;
            dirty = true;
          }
          if (zoomOn && !morph && !pivot.equals(panTo)) {
            const step = panTo.clone().sub(pivot);
            // Остаток меньше сотой миллиметра на карточке — встаём точно
            if (step.lengthSq() > 1e-10) step.multiplyScalar(1 - Math.exp(-dt / PAN_EASE));
            pivot.add(step);
            camera.position.add(step);
            controls?.target.copy(pivot);
            dirty = true;
          }
          if (controls) {
            if (spinFrom) {
              const k = clamp01((now - spinFrom) / SPIN_RAMP);
              controls.autoRotateSpeed = SPIN_SPEED * easeInOut(k);
              if (k >= 1 || !controls.autoRotate) {
                controls.autoRotateSpeed = SPIN_SPEED;
                spinFrom = 0;
              }
            }
            if (controls.update(dt / 1000)) dirty = true;
          } else if (!reduced && !morph) {
            // Сенсорные экраны: без управления, медленное вращение
            autoAzimuth += dt * 0.00012;
            placeCamera(camera, { radius: finalPose.radius, polar: autoPolar, azimuth: autoAzimuth });
            dirty = true;
          }
          // Колесо задало новое расстояние — доезжаем до него за ZOOM_EASE
          if (zoomOn && !morph && zoomFactor !== zoomTo) {
            zoomFactor += (zoomTo - zoomFactor) * (1 - Math.exp(-dt / ZOOM_EASE));
            if (Math.abs(zoomTo - zoomFactor) < 0.0005) zoomFactor = zoomTo;
            setRadius(finalPose.radius * zoomFactor);
            dirty = true;
          }
          if (morph) {
            const m = morph;
            const e = reduced
              ? 1
              : m.land
                ? easeLand(clamp01((now - m.start) / LAND_TIME))
                : easeInOut(clamp01((now - m.start) / MORPH_TIME));
            setFrame({
              cx: m.from.cx + (m.to.cx - m.from.cx) * e,
              cy: m.from.cy + (m.to.cy - m.from.cy) * e,
              size: m.from.size + (m.to.size - m.from.size) * e,
            });
            // Размер на экране ∝ 1/расстояние — ведём его линейно; при посадке заодно
            // возвращаем исходный наклон (поворот вокруг оси остаётся — макет крутится)
            // и сдвиг панорамы — карточка садится центром на своё место
            const s = new Spherical().setFromVector3(fromPivot());
            if (m.land) {
              pivot.lerpVectors(m.pivot0, origin, e);
              panTo.copy(pivot);
              controls?.target.copy(pivot);
            }
            placeCamera(camera, {
              radius: 1 / (1 / m.r0 + (1 / m.r1 - 1 / m.r0) * e),
              polar: m.land ? m.polar0 + (FINAL_POLAR - m.polar0) * e : s.phi,
              azimuth: s.theta,
            });
            if (e >= 1) {
              morph = null;
              m.done();
            }
          }
        } else if (outro) {
          const o = outro;
          // Сначала здание возвращается на своё место на иконке
          if (centerK > 0) setCenter(o.c0 * (1 - easeInOut(clamp01((now - o.start) / UNCENTER_TIME))));
          const u = clamp01((now - o.start) / OUTRO_UNBUILD);
          const glow = u < 1 ? Math.min(1, u * 6) * (1 - easeOut(Math.max(0, (u - 0.75) / 0.25))) : 0;
          setBuild((1 - easeInOut(u)) * o.h0, glow);
          // …и проявляется обратно, пока здание разбирается, — к взлёту карточка снова как иконка
          setPlate(reduced ? 1 : easeInOut(clamp01((u - 0.5) / 0.4)));
          setLineFade(1 - easeInOut(clamp01((now - o.start) / (OUTRO_TOTAL * 0.7))));
          const c = easeInOut(clamp01((now - o.start - (OUTRO_TOTAL - OUTRO_CAMERA)) / OUTRO_CAMERA));
          placeCamera(camera, {
            radius: o.from.radius + (topPose.radius - o.from.radius) * c,
            polar: o.from.polar + (topPose.polar - o.from.polar) * c,
            azimuth: o.from.azimuth + (topPose.azimuth - o.from.azimuth) * c,
          });
          // …и проявляются, пока карточка поднимается, — к концу она снова как картинка
          setLabels(clamp01((c - 0.4) / 0.6));
          if (now - o.start >= OUTRO_TOTAL) {
            outro = null;
            renderer.render(scene, camera);
            o.done();
            return;
          }
        }

        // Движение кончилось — возвращаем полное разрешение
        if (sizedLowRes && !lowRes()) applySize(true);
        // В покое (макет не вращается) кадр не перерисовываем. Плотность пикселей
        // подстраиваем только в покое: смена чёткости посреди анимации заметна
        if (phase === "idle") {
          if (!dirty) return;
          adaptDpr(rawDt);
        }
        dirty = false;
        renderer.render(scene, camera);
      };

      // Медленные кадры подряд — снижаем плотность пикселей, быстрые — возвращаем.
      // Возврат осторожный и с паузой: иначе плотность скачет туда-сюда, а каждая
      // смена пересоздаёт буфер холста — это и есть рывки.
      let lastAdapt = 0;
      const adaptDpr = (frameMs: number) => {
        const t0 = performance.now();
        if (frameMs > 500 || interacting() || t0 < adaptBlockUntil) return; // пауза, движение или смена размера
        slowSum += frameMs;
        if (++slowCount < 12) return;
        const avg = slowSum / slowCount;
        slowSum = slowCount = 0;
        const now = t0;
        const next =
          avg > 26
            ? Math.max(MIN_DPR_SCALE, dprScale * 0.8)
            : avg < 19 && now - lastAdapt > 1200
              ? Math.min(1, dprScale * 1.25)
              : dprScale;
        if (Math.abs(next - dprScale) < 0.01) return;
        dprScale = next;
        lastAdapt = now;
        applySize(true);
      };

      const io = new IntersectionObserver(([entry]) => {
        // В полноэкранном просмотре холст всегда на экране
        const nowVisible = entry.isIntersecting || isFull();
        if (nowVisible === visible) return;
        visible = nowVisible;
        if (visible) {
          lastNow = performance.now();
          dirty = true;
          raf = requestAnimationFrame(tick);
        } else {
          cancelAnimationFrame(raf);
          preloadNeighbours();
        }
      });
      io.observe(root);
      // Несколько событий за кадр (зум страницы) сводим в одно
      let resizeRaf = 0;
      const ro = new ResizeObserver(() => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          layout();
        });
      });
      ro.observe(root);
      ro.observe(fullHost);
      raf = requestAnimationFrame(tick);
      // Фоновая подготовка другого макета рисует на том же холсте — сразу возвращаем свой кадр
      mod.setRedraw(() => {
        if (shown) renderer.render(scene, camera);
      });

      // Обратная анимация перед уходом; если макет не на экране или ещё не показан — сразу
      reverse = async () => {
        await closeFull();
        if (reduced || !shown || !visible || phase === "outro") return;
        await playOutro();
      };

      cleanup = () => {
        reverse = null;
        cancelAnimationFrame(raf);
        cancelAnimationFrame(resizeRaf);
        for (const el of [hit, fullHost]) {
          el.removeEventListener("wheel", markInteract);
          el.removeEventListener("pointermove", onDrag);
        }
        clearTimeout(preloadTimer);
        document.removeEventListener("pointerover", onNeighbourIntent);
        document.removeEventListener("focusin", onNeighbourIntent);
        clearTimeout(settleTimer);
        io.disconnect();
        ro.disconnect();
        offTapInline();
        offTapFull();
        hit.removeEventListener("keydown", onHitKey);
        dialog.removeEventListener("cancel", onCancelDialog);
        dialog.removeEventListener("wheel", onDialogWheel);
        fullHost.removeEventListener("pointerdown", onPanDown);
        fullHost.removeEventListener("pointermove", onPanMove);
        fullHost.removeEventListener("pointerup", onPanUp);
        fullHost.removeEventListener("pointercancel", onPanUp);
        fullHost.removeEventListener("mousedown", onMiddleMouse);
        fullHost.removeEventListener("auxclick", onMiddleMouse);
        fullHost.removeEventListener("pointerdown", onPinchDown);
        fullHost.removeEventListener("pointermove", onPinchMove);
        fullHost.removeEventListener("pointerup", onPinchUp);
        fullHost.removeEventListener("pointercancel", onPinchUp);
        closeBtn.removeEventListener("click", onCloseBtn);
        if (dialog.open) dialog.close();
        delete dialog.dataset.open;
        controls?.dispose();
        // Сцена и рендерер остаются в кэше (modelScene) — снимаем только холст
        mod.setRedraw(null);
        canvas.remove();
      };
    })().catch((err) => {
      // Без WebGL или при ошибке загрузки остаётся обычная картинка
      console.warn("ProjectModel:", err);
      stage.dataset.model = "off";
    });

    return () => {
      disposed = true;
      document.removeEventListener("click", onNavClick, true);
      if (hooks.__popstateHook === onPopState) delete hooks.__popstateHook;
      cleanup();
    };
  }, [slug, icon, ink, bg, router]);

  return (
    <>
      <div ref={rootRef} className={styles.root} aria-hidden="true">
      </div>
      <div
        ref={hitRef}
        className={styles.hit}
        data-interactive={interactive ? "" : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? "3D-макет здания — открыть на весь экран" : undefined}
      />
      {/* Полноэкранный просмотр макета: сюда переезжает холст */}
      <dialog ref={dialogRef} className={styles.full} aria-label="3D-макет здания">
        <div ref={fullHostRef} className={styles.fullHost} />
        <button ref={closeRef} type="button" className={styles.close} aria-label="Закрыть">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </dialog>
    </>
  );
}
