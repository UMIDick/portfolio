/**
 * Плавность на телефоне (эмуляция: MOBILE=1 в driver.mjs — метрики Pixel-класса 390×844,
 * DPR 3, тач, CPU 4×): интервалы между кадрами (rAF) на каждом шаге мобильного сценария —
 * интро, прокрутка пальцем, раскрытие карточки программы, открытие проекта, карусель,
 * лист на весь экран со щипком, 3D-макет на весь экран (щипок, панорама двумя пальцами,
 * вращение пальцем), соседний проект, возврат на главную.
 * COLD=1 — чистый профиль (первый визит), SLUG — первый проект (по умолчанию school),
 * LOAF=1 — длинные кадры главного потока с атрибуцией, TRACE_STEP — трассировка шага.
 * Пишет .perf/mobile.json. Сайт должен быть собран и запущен (npm run build && npm run start).
 * Запуск: MOBILE=1 node scripts/perf/mobile.mjs
 */
import { writeFileSync } from "node:fs";
import { launch, sleep, MW, MH, out } from "./driver.mjs";

process.env.MOBILE ??= "1";
const BASE = process.env.BASE ?? "http://localhost:3000";
const SLUG = process.env.SLUG ?? "school";
const d = await launch();
const { tap, tapSel, swipe, pinch, twoFingerPan, rect, key, evaluate } = d;

// Счётчик кадров ставится на каждой новой странице (переходы Next — без перезагрузки)
await d.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__fr = []; window.__frGen = 0; window.__frStart = () => { if (window.__frOn) return; window.__frOn = true; const gen = ++window.__frGen; (function loop(prev) { requestAnimationFrame((t) => { if (gen !== window.__frGen) return; if (prev) window.__fr.push([t, t - prev]); if (window.__frOn) loop(t); }); })(0); };
    window.__frStart();`,
});

const results = [];
let stepStart = 0;
const begin = async () => {
  stepStart = await evaluate("performance.now()");
};
const end = async (name) => {
  const f = JSON.parse(await evaluate(`JSON.stringify(window.__fr.filter(([t]) => t >= ${stepStart}))`));
  const long = f.filter(([, v]) => v > 25).map(([t, v]) => `${Math.round(v)}@${Math.round(t - v - stepStart)}`);
  const worst = f.map(([, v]) => v).sort((a, b) => b - a).slice(0, 5).map(Math.round);
  const over = Math.round(f.reduce((s, [, v]) => s + Math.max(0, v - 17.5), 0));
  results.push({ name, frames: f.length, worst, over, long });
  console.log(`${name.padEnd(36)} кадров ${String(f.length).padStart(4)}  худшие ${worst.join(" ").padEnd(20)} сверх 17 мс: ${over} мс  ${long.length ? "долгие: " + long.join(" ") : ""}`);
  if (process.env.LOAF) {
    const loaf = JSON.parse(await evaluate(`JSON.stringify((window.__prof?.loaf ?? []).filter((l) => l.start >= ${stepStart}))`));
    for (const l of loaf.filter((l) => l.dur > 40)) {
      const s = l.scripts.sort((a, b) => b.dur - a.dur).slice(0, 3).map((s) => `${s.fn || s.name}(${Math.round(s.dur)}${s.forced ? `, forced ${Math.round(s.forced)}` : ""})`);
      console.log(`      loaf ${Math.round(l.dur)}@${Math.round(l.start - stepStart)} block ${Math.round(l.block)} render ${Math.round(l.render)} sl ${Math.round(l.styleLayout)} ${s.join(", ")}`);
    }
  }
};
/** Шаг: действие, замер кадров в первые measure мс, затем тихая пауза до ms. */
const step = async (name, act, ms, measure = Math.min(ms, 2500)) => {
  const trace = process.env.TRACE_STEP && name.startsWith(process.env.TRACE_STEP);
  if (trace) await d.traceStart();
  await evaluate("window.__frStart(), 1");
  await begin();
  await act();
  await sleep(measure);
  if (trace) await d.traceStop("trace-step.json");
  await end(name);
  await evaluate("window.__frOn = false, 1");
  if (ms > measure) await sleep(ms - measure);
};
/** Центр первого элемента, целиком видимого в окне. */
const visible = (sel) =>
  evaluate(`(() => { for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
    const b = el.getBoundingClientRect(); if (b.width && b.top >= 0 && b.bottom <= innerHeight) return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } return null; })()`);
/** Листать пальцем (dir 1 — вниз по странице, -1 — вверх), пока элемент не станет целиком виден. */
const swipeTo = async (sel, max = 14, dir = 1) => {
  for (let i = 0; i < max; i++) {
    const r = await visible(sel);
    if (r) return r;
    await swipe(MW / 2, dir > 0 ? MH * 0.72 : MH * 0.28, 0, dir * -MH * 0.55);
    await sleep(350);
  }
  throw new Error("не долистал до " + sel);
};
/** Дождаться элемента (готовность макета и т.п.), мс. */
const waitFor = async (sel, ms = 15000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) return;
    await sleep(250);
  }
  throw new Error("не дождался " + sel);
};

await d.navigate(BASE + "/");
await sleep(300);
console.log(
  "  среда:",
  await evaluate(
    `JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, coarse: matchMedia("(hover: none) and (pointer: coarse)").matches, touch: navigator.maxTouchPoints })`,
  ),
);
stepStart = 0;
await sleep(3000);
await end("интро (загрузка)");
await evaluate("window.__frOn = false, 1");
await sleep(1200);

await step("прокрутка к резюме (свайп)", () => swipe(MW / 2, MH * 0.72, 0, -MH * 0.6), 2000);
const tool = await swipeTo('li[aria-expanded="false"]');
await step("карточка программы: раскрытие", () => tap(tool.x, tool.y), 900);
await step("карточка программы: закрытие", () => tap(tool.x, tool.y), 900);

const card = await swipeTo(`a[href="/projects/${SLUG}"]`);
await sleep(600);
await step(`открытие ${SLUG}: переход`, () => tap(card.x, card.y), 1500);
await step(`${SLUG}: листы и сборка макета`, async () => {}, 5000, 5000);

const track = await rect('ul[class*="track"]');
await step("карусель: свайп листов", () => swipe(track.x, track.y, -MW * 0.6, 0), 1200);
await step("лист: открыть", () => tapSel('ul[class*="track"] li:nth-child(2) button'), 1000);
await step("лист: щипок (приближение)", () => pinch(MW / 2, MH / 2, 90, 320), 800);
await step("лист: закрыть", () => key("Escape", "Escape", 27), 1000);

await waitFor('div[class*="hit"][data-interactive]');
const hit = await rect('div[class*="hit"]');
await step("макет: на весь экран", () => tap(hit.x, hit.y), 1300);
await step("макет: щипок (приближение)", () => pinch(MW / 2, MH / 2, 100, 300), 800);
await step("макет: панорама двумя пальцами", () => twoFingerPan(MW / 2, MH / 2, 120, -80, -60), 800);
await step("макет: вращение пальцем", () => swipe(MW / 2, MH / 2, 140, 40, { fling: true }), 600);
await step("макет: закрытие (нажатие)", () => tap(MW / 2, MH / 2), 2200);

await d.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
const next = await swipeTo('a[data-nav="proj-next"]');
await step("соседний проект: переход", () => tap(next.x, next.y), 1500);
await step("соседний: сборка макета", async () => {}, 4500, 4500);
console.log("  →", await evaluate("location.pathname"));

const back = await swipeTo('a[data-nav="proj-close"]', 8, -1);
await step("← Портфолио: разборка + переход", () => tap(back.x, back.y), 3500, 3500);
console.log("  →", await evaluate("location.pathname"));

const card2 = await swipeTo('a[href="/projects/tower"], a[href="/projects/flat"]');
await sleep(600);
await step("открытие ещё одного проекта", () => tap(card2.x, card2.y), 1500);
await step("его сборка", async () => {}, 4500, 4500);
console.log("  →", await evaluate("location.pathname"));
await step("«Назад» в браузере", () => evaluate("history.back(), 1"), 3500, 3500);
console.log("  →", await evaluate("location.pathname"));

writeFileSync(out("mobile.json"), JSON.stringify(results, null, 1));
d.close();
