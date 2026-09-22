/**
 * Плавность глазами посетителя: интервалы между кадрами (rAF) на каждом шаге сценария —
 * интро, экраны главной, открытие проекта (переход + сборка макета), макет на весь экран
 * с приближением и панорамой, закрытие, соседний проект, возврат на главную, «Назад».
 * Печатает по шагам: число кадров, худшие интервалы и где они (мс от начала шага).
 * COLD=1 — чистый профиль (первый визит), SLUG — первый проект (по умолчанию school),
 * FAST=1 — нетерпеливый посетитель (клик по проекту почти сразу после прихода на экран).
 * LOAF=1 — ещё и длинные кадры главного потока с атрибуцией, TRACE_STEP — трассировка шага.
 * Пишет .perf/smooth.json. Сайт должен быть собран и запущен (npm run build && npm run start).
 */
import { writeFileSync } from "node:fs";
import { launch, sleep, W, H, out } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SLUG = process.env.SLUG ?? "school";
const FAST = !!process.env.FAST;
const d = await launch();
const { wheel, move, click, rect, clickSel, key, evaluate } = d;

// Счётчик кадров ставится на каждой новой странице (переходы Next — без перезагрузки)
await d.send("Page.addScriptToEvaluateOnNewDocument", {
  // Цикл идёт только во время замера (__frOn): постоянный rAF сам отнимал бы у страницы
  // простой, и фоновая подготовка (прогрев, макеты) шла бы не так, как у посетителя
  // (поколение gen — чтобы после быстрой остановки и запуска не шли два цикла сразу)
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
  console.log(`${name.padEnd(34)} кадров ${String(f.length).padStart(4)}  худшие ${worst.join(" ").padEnd(20)} сверх 17 мс: ${over} мс  ${long.length ? "долгие: " + long.join(" ") : ""}`);
  // LOAF=1 — длинные кадры главного потока в этом шаге: что в них исполнялось
  if (process.env.LOAF) {
    const loaf = JSON.parse(await evaluate(`JSON.stringify((window.__prof?.loaf ?? []).filter((l) => l.start >= ${stepStart}))`));
    for (const l of loaf.filter((l) => l.dur > 40)) {
      const s = l.scripts.sort((a, b) => b.dur - a.dur).slice(0, 3).map((s) => `${s.fn || s.name}(${Math.round(s.dur)}${s.forced ? `, forced ${Math.round(s.forced)}` : ""})`);
      console.log(`      loaf ${Math.round(l.dur)}@${Math.round(l.start - stepStart)} block ${Math.round(l.block)} render ${Math.round(l.render)} sl ${Math.round(l.styleLayout)} ${s.join(", ")}`);
    }
  }
};
/** Нажать первый элемент, который виден в окне (ссылки есть и в шапке, и на втором экране). */
const clickVisible = async (sel) => {
  const r = await evaluate(`(() => { for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
    const b = el.getBoundingClientRect(); if (b.width && b.top >= 0 && b.bottom <= innerHeight) return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } return null; })()`);
  if (!r) throw new Error("не видно " + sel);
  await click(r.x, r.y);
};
/** Шаг: действие, замер кадров в первые measure мс, затем тихая пауза до ms. */
// TRACE_STEP=<начало названия шага> — трассировка этого шага в .perf/trace-step.json (разбор — analyze.mjs)
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

await d.navigate(BASE + "/");
await sleep(300);
stepStart = 0;
await sleep(3000);
await end("интро (загрузка)");
await evaluate("window.__frOn = false, 1");
await sleep(1200);
await step("главная → резюме", () => wheel(W / 2, H / 2, 120), FAST ? 1300 : 3500);
await step("главная → проекты", () => wheel(W / 2, H / 2, 120), FAST ? 1300 : 6500);

const card = await rect(`a[href="/projects/${SLUG}"]`);
await move(card.x, card.y);
await sleep(FAST ? 150 : 900);
await step(`открытие ${SLUG}: переход`, () => click(card.x, card.y), 1500);
await step(`${SLUG}: листы и сборка макета`, async () => {}, 5000, 5000);

const hit = await rect('div[class*="hit"]');
await step("макет: на весь экран", () => click(hit.x, hit.y), 1300);
await step("макет: приближение", () => wheel(W / 2, H / 2, -100, 5, 80), 800);
await step("макет: вращение", async () => {
  await d.mouse("mousePressed", W / 2, H / 2, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    await d.mouse("mouseMoved", W / 2 + i * 12, H / 2 + i * 3, { button: "left", buttons: 1 });
    await sleep(16);
  }
  await d.mouse("mouseReleased", W / 2 + 240, H / 2 + 60, { button: "left", clickCount: 1 });
}, 500);
await step("макет: панорама колесиком", async () => {
  await d.mouse("mousePressed", W / 2, H / 2, { button: "middle", clickCount: 1 });
  for (let i = 1; i <= 15; i++) {
    await d.mouse("mouseMoved", W / 2 - i * 10, H / 2 - i * 6, { button: "middle", buttons: 4 });
    await sleep(16);
  }
  await d.mouse("mouseReleased", W / 2 - 150, H / 2 - 90, { button: "middle", clickCount: 1 });
}, 500);
await step("макет: закрытие (Esc)", () => key("Escape", "Escape", 27), 2200);

await step("лист: открыть", () => clickSel('ul[class*="track"] li:nth-child(2) button'), 1000);
await step("лист: приближение колесом", () => wheel(W / 2, H / 2, -100, 4, 80), 700);
await step("лист: закрыть", () => key("Escape", "Escape", 27), 1000);

await step("→ второй экран проекта", () => wheel(W / 2, 200, 120), 1600);
await step("соседний проект: переход", () => clickVisible('a[data-nav="proj-next"]'), 1500);
await step("соседний: сборка макета", async () => {}, 4500, 4500);
console.log("  →", await evaluate("location.pathname"));
await step("← Портфолио: разборка + переход", () => clickVisible('a[data-nav="proj-close"]'), 3500, 3500);

const card2 = await rect('a[href="/projects/tower"], a[href="/projects/flat"]');
await move(card2.x, card2.y);
await sleep(600);
await step("открытие ещё одного проекта", () => click(card2.x, card2.y), 1500);
await step("его сборка", async () => {}, 4500, 4500);
console.log("  →", await evaluate("location.pathname"));
await step("«Назад» в браузере", () => evaluate("history.back(), 1"), 3500, 3500);
console.log("  →", await evaluate("location.pathname"));

writeFileSync(out("smooth.json"), JSON.stringify(results, null, 1));
d.close();
