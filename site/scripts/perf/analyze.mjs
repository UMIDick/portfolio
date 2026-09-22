// Разбор трассировки Chrome: длинные задачи главного потока, растр, GPU — по отметкам фаз.
// node --max-old-space-size=8000 scripts/perf/analyze.mjs [.perf/trace-A.json] [порог мс]; MARKPFX="A:" — отметки сценария.
import { readFileSync } from "node:fs";

import { out } from "./driver.mjs";
const file = process.argv[2] ?? out("trace-B.json");
const MIN = Number(process.argv[3] ?? 25); // порог длинной задачи, мс
const { traceEvents: ev } = JSON.parse(readFileSync(file, "utf8"));

// Потоки
const threads = new Map(); // pid:tid → name
const procs = new Map();
for (const e of ev) {
  if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
  if (e.ph === "M" && e.name === "process_name") procs.set(e.pid, e.args.name);
}
const tname = (e) => threads.get(`${e.pid}:${e.tid}`) ?? "?";
const pname = (e) => procs.get(e.pid) ?? "?";

// Главный поток рендерера — тот, где больше всего событий
const mainCount = new Map();
for (const e of ev) if (tname(e) === "CrRendererMain") mainCount.set(`${e.pid}:${e.tid}`, (mainCount.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
const mainKey = [...mainCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const [mainPid] = mainKey.split(":").map(Number);
const isMain = (e) => `${e.pid}:${e.tid}` === mainKey;

// Отметки фаз (blink.user_timing)
const marks = ev
  .filter((e) => e.cat?.includes("blink.user_timing") && ["R","I","n","i","b"].includes(e.ph) && e.name.startsWith(process.env.MARKPFX ?? "") && !["navigationStart", "fetchStart", "responseEnd", "domLoading", "domInteractive", "domComplete", "loadEventStart", "loadEventEnd", "domContentLoadedEventStart", "domContentLoadedEventEnd", "firstPaint", "firstContentfulPaint", "requestStart", "unloadEventStart", "unloadEventEnd", "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "responseStart", "redirectStart", "redirectEnd", "secureConnectionStart", "workerStart", "firstImagePaint", "firstMeaningfulPaint", "firstMeaningfulPaintCandidate", "commitNavigationEnd"].includes(e.name))
  .map((e) => ({ name: e.name, ts: e.ts }))
  .sort((a, b) => a.ts - b.ts);
let t0 = Infinity; for (const e of ev) if (e.ts > 0 && e.ts < t0) t0 = e.ts;
const ms = (us) => Math.round((us - t0) / 1000);
const phaseAt = (ts) => {
  const i = marks.findIndex((m) => m.ts > ts);
  return i >= 0 ? `…→ ${marks[i].name}` : `после «${marks.at(-1)?.name ?? "-"}»`;
};

// Полные события (X) главного потока: верхнеуровневые задачи
const main = ev.filter((e) => isMain(e) && e.ph === "X" && e.dur).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const TOP = new Set(["RunTask", "ThreadControllerImpl::RunTask", "MessageLoop::RunTask", "TaskQueueManager::ProcessTaskFromWorkQueue"]);
const tasks0 = main.filter((e) => TOP.has(e.name) && e.dur / 1000 >= MIN); const tasks = tasks0.filter((e) => !tasks0.some((o) => o !== e && o.ts <= e.ts && o.ts + o.dur >= e.ts + e.dur && (o.ts < e.ts || o.dur > e.dur || tasks0.indexOf(o) < tasks0.indexOf(e))));

// Дети задачи: собственное время по именам (первый уровень значимых событий)
const IGNORE = new Set(["RunTask", "ThreadControllerImpl::RunTask", "MessageLoop::RunTask", "TaskQueueManager::ProcessTaskFromWorkQueue", "ThreadControllerImpl::DoWork", "SequenceManager::RunTask"]);
function breakdown(task) {
  const inside = main.filter((e) => e !== task && e.ts >= task.ts && e.ts + e.dur <= task.ts + task.dur && !IGNORE.has(e.name));
  // собственное время = длительность минус вложенные события того же списка
  const self = new Map();
  const details = [];
  for (const e of inside) {
    let child = 0;
    for (const c of inside) if (c !== e && c.ts >= e.ts && c.ts + c.dur <= e.ts + e.dur && (c.ts > e.ts || c.dur < e.dur)) child += c.dur;
    // вложенные могут пересчитываться дважды (внуки) — грубая оценка, но верхние имена видны
    const s = Math.max(0, e.dur - child);
    self.set(e.name, (self.get(e.name) ?? 0) + s);
    if (e.dur / 1000 >= 8) {
      const a = e.args?.data ?? e.args ?? {};
      const extra = a.functionName ? `${a.functionName}@${(a.url ?? "").split("/").pop()}:${a.lineNumber}` : a.url ? (a.url + "").split("/").pop() : a.type ?? "";
      details.push(`${e.name}${extra ? `[${extra}]` : ""} ${(e.dur / 1000).toFixed(1)}`);
    }
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, d]) => `${n} ${(d / 1000).toFixed(1)}`);
  return { top, details: details.slice(0, 8) };
}

// Растровые потоки и GPU
const raster = ev.filter((e) => e.ph === "X" && e.dur && /CompositorTileWorker|ThreadPoolForegroundWorker/.test(tname(e)) && e.pid === mainPid);
const gpu = ev.filter((e) => e.ph === "X" && e.dur && pname(e).includes("GPU") && tname(e) === "CrGpuMain");
const compositor = ev.filter((e) => e.ph === "X" && e.dur && tname(e) === "Compositor" && e.pid === mainPid);

const sumIn = (list, from, to, filter = () => true) => {
  const m = new Map();
  for (const e of list) if (e.ts < to && e.ts + e.dur > from && filter(e)) m.set(e.name, (m.get(e.name) ?? 0) + Math.min(e.ts + e.dur, to) - Math.max(e.ts, from));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, d]) => `${n} ${(d / 1000).toFixed(0)}`);
};

console.log(`Файл ${file}; главный поток ${mainKey}; отметки: ${marks.map((m) => `${m.name}@${ms(m.ts)}`).join(" | ")}`);
console.log(`\nДлинные задачи главного потока (≥${MIN} мс):`);
let lastPhase = "";
for (const t of tasks) {
  const ph = phaseAt(t.ts);
  if (ph !== lastPhase) {
    console.log(`\n== ${ph}`);
    lastPhase = ph;
  }
  const b = breakdown(t);
  console.log(`  ${(t.dur / 1000).toFixed(0)}ms @${ms(t.ts)}  ${b.top.join(", ")}`);
  if (b.details.length) console.log(`      ${b.details.join(" · ")}`);
}

// Длинные кадры без длинных задач: смотрим на растр/GPU по фазам (окна между отметками)
console.log("\nРастр (CompositorTileWorker) и GPU по фазам, мс суммарно:");
const bounds = [t0, ...marks.map((m) => m.ts), Infinity];
for (let i = 0; i < bounds.length - 1; i++) {
  const from = bounds[i];
  let to = bounds[i + 1]; if (to === Infinity) { to = 0; for (const e of ev) if (e.ts + (e.dur || 0) > to) to = e.ts + (e.dur || 0); }
  const name = i < marks.length ? `…→ ${marks[i].name}` : `после «${marks.at(-1)?.name}»`;
  const r = sumIn(raster, from, to, (e) => ["RasterTask", "ImageDecodeTask", "TileTaskWorker::RunTask", "RasterizerTaskImpl::RunOnWorkerThread", "SoftwareImageDecodeTaskImpl", "GpuImageDecodeTaskImpl", "Decode LazyPixelRef", "Draw LazyPixelRef"].includes(e.name));
  const g = sumIn(gpu, from, to, (e) => ["GPUTask", "SkiaOutputSurfaceImplOnGpu::FinishPaintRenderPass", "SkiaOutputSurfaceImplOnGpu::SwapBuffers", "GLES2DecoderImpl::DoCommands", "RasterDecoderImpl::DoCommands", "DirectRenderer::DrawFrame", "SkiaRenderer::FinishDrawingRenderPass", "Display::DrawAndSwap"].includes(e.name));
  const c = sumIn(compositor, from, to, (e) => /Commit|Activate|BeginFrame|Draw|Raster|Layers|Prepare|Impl/.test(e.name));
  console.log(`  ${name}: растр [${r.join(", ")}]  gpu [${g.join(", ")}]  композ. [${c.join(", ")}]`);
}

// Самые долгие GPU-задачи
const longGpu = gpu.filter((e) => e.dur / 1000 >= 12).sort((a, b) => b.dur - a.dur).slice(0, 10);
if (longGpu.length) console.log("\nДолгие задачи GPU:", longGpu.map((e) => `${e.name} ${(e.dur / 1000).toFixed(0)}@${ms(e.ts)} (${phaseAt(e.ts)})`).join(" · "));
// Самые долгие растровые задачи
const longRaster = raster.filter((e) => e.dur / 1000 >= 12).sort((a, b) => b.dur - a.dur).slice(0, 10);
if (longRaster.length) console.log("\nДолгие растровые задачи:", longRaster.map((e) => `${e.name} ${(e.dur / 1000).toFixed(0)}@${ms(e.ts)} (${phaseAt(e.ts)})`).join(" · "));
