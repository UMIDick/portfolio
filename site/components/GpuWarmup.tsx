"use client";

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { idlePause } from "@/lib/idle";
import { gpuWarmDone, WARM_STAGES } from "@/lib/gpu-warm";
import type { Project, Sheet } from "@/lib/types";

const WarmPage = lazy(() => import("./WarmPage"));

/** Раньше этого времени от загрузки (мс) не начинаем: играет интро (последняя плитка встаёт на ~2,75 с). */
const INTRO_DONE = 2800;
/** Сколько держим копию экрана резюме, мс: каскад играет с настоящими задержками
    (без них получались другие варианты шейдеров, и настоящий каскад компилировал их заново);
    с RESUME_HOVER_AT карточки переходят в состояние «под курсором» (анимация тени и блика:
    после прокрутки курсор обычно оказывается над карточкой). */
const RESUME_MS = 3800;
const RESUME_HOVER_AT = 3200;
/** Копия экрана проектов: каскад карточек (5,6 с, как busyMs у ProjectCards) в PROJECTS_RATE раз
    быстрее — промежуточные состояния (а с ними и шейдеры) те же, а посетитель не успевал
    долистать до конца копии и она снималась; затем карточки «под курсором». */
const PROJECTS_RATE = 4;
const PROJECTS_MS = 1700;
const PROJECTS_HOVER_AT = 1450;
/** Столько ждём картинки слоя перед холостым переходом и, в конце, перед снятием слоя, мс. */
const IMAGES_WAIT = 400;
const IMAGES_TIMEOUT = 4000;
let warmedUp = false;

const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Тяжёлые для видеокарты шаги — только когда посетитель ничего не делает. */
const calm = () => idlePause({ quiet: true });

/**
 * Прогрев видеокарты перед первым переходом на страницу проекта.
 *
 * У нового посетителя GPU-процесс браузера компилирует шейдеры в тот момент, когда
 * эффект впервые попадает в кадр: маска-круг, гаснущий снимок страницы, свечение
 * летящей иконки, панель листов с градиентами и зерном, тени, листы… Всё это впервые
 * встречалось посреди перехода: ~40 программ, ~600 мс компиляции, 4–5 кадров
 * по 60–300 мс (в трассировке — ANGLE RunWorkerTask внутри DoEndRasterCHROMIUM::Flush
 * и FinishPaintRenderPass). При повторном входе шейдеры уже в кэше — поэтому
 * «зависал» только первый вход.
 *
 * Здесь то же самое один раз проигрывается в простое на главной, невидимо
 * (слой под фильтром полной прозрачности, стили — .gpu-warm в globals.css):
 *  0) копия экрана резюме (`resume` — тот же компонент с `warm`) с её каскадом появления
 *     (играет в фоне, шаги 1–2 идут одновременно с ней):
 *     первое, что делает посетитель, — кнопка «Резюме» или колесо, и без прогрева
 *     стеклянные карточки и их анимации компилировались прямо в прокрутке
 *     (~40 программ, кадры 150–320 мс; замер — scripts/perf/resume.mjs).
 *     Если посетитель уже листает — шаг снимается;
 *  1) страница проекта «вхолостую» (WarmPage: настоящие классы и карусель) — растр
 *     и компоновка её эффектов, заодно картинки первого проекта попадают в кэш;
 *     появляется по частям (WARM_STAGES), чтобы видеокарта не была занята подолгу;
 *  2) настоящий View Transition с теми же классами, что ставит React;
 *  3) иконка «гаснет», как при появлении 3D-макета (data-model="on"), и открывается
 *     просмотр листа на весь экран (SheetViewerWarm);
 *  4) копия экрана проектов (`projects`) с каскадом карточек (ускоренным) — вместе с резюме,
 *     пока посетитель до проектов не дошёл; прервал прокруткой — повторяем в тихий момент.
 * Каждый шаг ждёт «тихого» простоя (lib/idle, quiet): пока видеокарта компилирует,
 * кадры главной задерживаются, и на прокрутке это был бы рывок.
 * Проверка — scripts/perf/first.mjs (COLD=1 TRACE=1 SKIA=1) и shaders.mjs:
 * сколько программ компилируется после клика (было 39 / 575 мс, стало 8 / 94 мс).
 */
export default function GpuWarmup({
  project,
  lockedSheets,
  resume,
  projects,
}: {
  project: Project;
  /** Листы проекта, чья лента заблокирована (размыта), — у них свои шейдеры (WarmPage). */
  lockedSheets?: Sheet[];
  resume: ReactNode;
  projects: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(0);
  const [resumeOn, setResumeOn] = useState(false);
  const [projectsOn, setProjectsOn] = useState(false);

  useEffect(() => {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (warmedUp || saveData) {
      gpuWarmDone();
      return;
    }
    let cancelled = false;
    let vt: ViewTransition | null = null;
    const html = document.documentElement;
    const stop = () => {
      cancelled = true;
      vt?.skipTransition();
      delete html.dataset.gpuWarm;
      setStage(0);
      setResumeOn(false);
      setProjectsOn(false);
      gpuWarmDone();
    };
    /** Проиграть копию экрана: true — доиграла, false — посетитель начал листать. */
    const play = async (show: (on: boolean) => void, cls: string, ms: number, hoverAt: number, rate = 1) => {
      show(true);
      if (rate !== 1)
        void (async () => {
          // Каскад стартует, когда Stagger копии увидел себя в окне, — тогда и ускоряем
          for (let i = 0; i < 60; i++) {
            await frames(1);
            const root = document.querySelector(cls);
            if (!root) return;
            if (root.querySelector('[data-reveal="in"]')) {
              root.getAnimations({ subtree: true }).forEach((a) => (a.playbackRate = rate));
              return;
            }
          }
        })();
      const hover = setTimeout(() => document.querySelector(cls)?.classList.add("gpu-warm-hover"), hoverAt);
      const done = await Promise.race([
        sleep(ms).then(() => true),
        new Promise<boolean>((r) => window.addEventListener("scroll", () => r(false), { once: true, passive: true })),
      ]);
      clearTimeout(hover);
      show(false);
      return done;
    };
    /** Настоящий каскад раздела проектов уже сыгран — его шейдеры и так в кэше. */
    const projectsShown = () =>
      (document.querySelector<HTMLElement>("#projects [data-stagger]")?.dataset.reveal ?? "pending") !== "pending";
    // Настоящая навигация важнее: сразу убираем всё своё
    const onNav = (e: Event) => {
      if ((e.target as Element | null)?.closest?.("a[data-nav]")) stop();
    };
    document.addEventListener("click", onNav, true);

    (async () => {
      await sleep(Math.max(0, INTRO_DONE - performance.now()));
      await calm();
      if (cancelled) return;
      warmedUp = true;

      // 0. Экран резюме; начал листать — настоящий каскад важнее, копию снимаем.
      // Копия играет свой каскад в фоне, а страница проекта прогревается одновременно:
      // по очереди прогрев не успевал — ввод и каскады разделов (у проектов 5 с) всё время
      // его откладывали, и к первому клику по проекту было готово 7 программ из ~40
      let resumeDone: Promise<unknown> = Promise.resolve();
      if (window.scrollY < 2) {
        resumeDone = play(setResumeOn, ".gpu-warm-resume", RESUME_MS, RESUME_HOVER_AT);
        // 4. Экран проектов — тут же, своим ходом (не задерживает шаги 1–3); прервали — повторяем
        void (async () => {
          let first = true;
          while (!cancelled && !projectsShown()) {
            if (!first) {
              await frames(2);
              await calm();
              if (cancelled || projectsShown()) return;
            }
            first = false;
            if (await play(setProjectsOn, ".gpu-warm-projects", PROJECTS_MS, PROJECTS_HOVER_AT, PROJECTS_RATE)) return;
          }
        })();
        await frames(3);
        await calm();
        if (cancelled) return;
      }

      // 1. Страница проекта «вхолостую», по частям
      for (let s = 1; s <= WARM_STAGES; s++) {
        setStage(s);
        await frames(3);
        await calm();
        if (cancelled) return;
      }
      // Картинки почти не ждём: переходу они не важны, а обложка при первом запросе
      // готовится на сервере секунды — свои кадры они получат на шаге 3
      const imgs = [...(ref.current?.querySelectorAll("img") ?? [])];
      const decoded = Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      await Promise.race([decoded, sleep(IMAGES_WAIT)]);
      await frames(3);
      await calm();
      if (cancelled) return;

      // 2. Эффекты перехода — самое заметное, поэтому раньше остального
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (document.startViewTransition && !reduced) {
        html.dataset.gpuWarm = "a";
        await frames(2);
        if (cancelled) return;
        try {
          vt = document.startViewTransition(() => {
            html.dataset.gpuWarm = "b";
          });
          await vt.finished;
        } catch {
          // Прервано настоящим переходом
        }
        vt = null;
        delete html.dataset.gpuWarm;
      }
      await resumeDone;
      // Главное сделано — подготовка 3D-макетов (ModelPreload) может начинаться
      gpuWarmDone();
      await calm();
      if (cancelled) return;

      // 3. Иконка гаснет под 3D-макетом; листы карусели к этому времени уже въехали.
      // Обложку (JPEG — свой шейдер) ждём ещё немного, чтобы и она попала в кадр
      ref.current?.querySelector("[data-warm-stage]")?.setAttribute("data-model", "on");
      // …и просмотр листа на весь экран (размытый фон, лист с тенью, стеклянные кнопки)
      setStage(WARM_STAGES + 1);
      await Promise.race([decoded.then(() => frames(3)), sleep(IMAGES_TIMEOUT)]);
      await sleep(450);
      // Слой страницы проекта больше не нужен (копия экрана проектов может ещё играть)
      if (!cancelled) setStage(0);
    })();

    return () => {
      document.removeEventListener("click", onNav, true);
      stop();
    };
  }, []);

  if (!resumeOn && !projectsOn && !stage) return null;
  return (
    <>
      {resumeOn && (
        <div className="gpu-warm gpu-warm-resume" aria-hidden="true" inert>
          {resume}
        </div>
      )}
      {projectsOn && (
        <div className="gpu-warm gpu-warm-projects" aria-hidden="true" inert>
          {projects}
        </div>
      )}
      {stage > 0 && (
        <div ref={ref} className="gpu-warm" aria-hidden="true" inert>
          <Suspense fallback={null}>
            <WarmPage project={project} lockedSheets={lockedSheets} stage={stage} />
          </Suspense>
          <div className="gpu-warm-old" />
          <div className="gpu-warm-old2" />
          <div className="gpu-warm-new2" />
        </div>
      )}
    </>
  );
}
