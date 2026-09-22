/**
 * Каскад карточек проектов: интро → резюме → проекты (колесом), пока карточки разъезжаются.
 * COLD=1 — чистый профиль, CPU=4 — замедление, AT — пауза на интро, мс (по умолчанию 2500),
 * STAY — сколько пробыть на резюме, мс (по умолчанию 1300).
 * TRACE=1 — трассировка от прихода на экран проектов (.perf/trace-cards.json → frames.mjs, analyze.mjs).
 * Пишет .perf/first.json: `node scripts/perf/report.mjs .perf/first.json`.
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const d = await launch();
await d.navigate(BASE + "/");
await sleep(Number(process.env.AT ?? 2500));
await d.mark("интро");
await d.wheel(W / 2, H / 2, 120);
await sleep(Number(process.env.STAY ?? 1300));
await d.mark("→ резюме");
if (process.env.TRACE) await d.traceStart();
await d.wheel(W / 2, H / 2, 120);
await sleep(1000); await d.mark("→ проекты: переход");
await sleep(1000); await d.mark("карточки: квартира");
await sleep(1400); await d.mark("карточки: дом");
await sleep(1400); await d.mark("карточки: школа");
await sleep(2000); await d.mark("карточки: все на местах");
await sleep(2500); await d.mark("после каскада");
if (process.env.TRACE) await d.traceStop("trace-cards.json");
await d.collect("first.json");
d.close();
