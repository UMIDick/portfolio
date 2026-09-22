/**
 * Первый визит нетерпеливого посетителя: страница открылась, быстрый скролл к проектам
 * и сразу клик по карточке — фоновая подготовка (ModelPreload) не успела закончиться.
 * COLD=1 — чистый профиль браузера, CPU=4 — замедление. SLUG — проект (по умолчанию school),
 * WAIT — пауза перед кликом после прихода на экран проектов, мс (по умолчанию 900).
 * HOVER — сколько держать курсор на карточке до клика, мс (по наведению готовится макет).
 * TRACE=1 — ещё и трассировка от клика (.perf/trace-first.json, разбор — analyze.mjs);
 * вместе с SKIA=1 — компиляции шейдеров GPU-процесса: `node --max-old-space-size=8000 scripts/perf/shaders.mjs`.
 * Пишет .perf/first.json: `node scripts/perf/report.mjs .perf/first.json`.
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SLUG = process.env.SLUG ?? "school";
const WAIT = Number(process.env.WAIT ?? 900);
const HOVER = Number(process.env.HOVER ?? 0);
const d = await launch();
const { mark, wheel, click, rect, evaluate } = d;

await d.navigate(BASE + "/");
await sleep(Number(process.env.INTRO ?? 2500));
await mark("home: интро");
await wheel(W / 2, H / 2, 120); await sleep(1300); await mark("home: → резюме");
await wheel(W / 2, H / 2, 120); await sleep(1300); await mark("home: → проекты");
await sleep(WAIT);
const card = await rect(`a[href="/projects/${SLUG}"]`);
if (process.env.TRACE) await d.traceStart();
if (HOVER) { await d.move(card.x, card.y); await sleep(HOVER); }
await mark("перед кликом");
await click(card.x, card.y);
await sleep(1300); await mark("proj-open: переход (1.3с)");
await sleep(1500); await mark("proj-open: листы въехали");
await sleep(4500); await mark("proj-open: макет построен");
console.log("  path", await evaluate("location.pathname"));

if (process.env.TRACE) await d.traceStop("trace-first.json");
await d.collect("first.json");
d.close();
