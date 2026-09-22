/**
 * Первый визит: кнопка со стрелкой на интро → экран резюме (MODE=wheel — то же колесом).
 * COLD=1 — чистый профиль, AT — когда нажать, мс от загрузки (по умолчанию 3000),
 * TRACE=1 SKIA=1 — трассировка от нажатия (.perf/trace-first.json → shaders.mjs).
 * Пишет .perf/first.json: `node scripts/perf/report.mjs .perf/first.json`.
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const d = await launch();
if (process.env.TRACE === "2") await d.traceStart(); // с самой загрузки: видно и прогрев
await d.navigate(BASE + "/");
await sleep(Number(process.env.AT ?? 3000));
const btn = await d.rect('a[href="#resume"]');
if (process.env.TRACE === "1") await d.traceStart();
await d.mark("перед кликом");
if (process.env.MODE === "wheel") await d.wheel(W / 2, H / 2, 120);
else await d.click(btn.x, btn.y);
await sleep(1300); await d.mark("→ резюме: переход");
await sleep(2500); await d.mark("→ резюме: каскад сыграл");
console.log("  scrollY", await d.evaluate("scrollY"));
if (process.env.TRACE) await d.traceStop("trace-first.json");
await d.collect("first.json");
d.close();
