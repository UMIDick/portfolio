// Какие шейдеры Skia GPU-процесс компилирует после отметки (по умолчанию «перед кликом»):
// трассировка с SKIA=1 (first.mjs). Для каждой компиляции — время от отметки, длительность
// и операция Skia, которой понадобилась программа (FillRectOp, TextureOp, размытие, маска…).
// node --max-old-space-size=8000 scripts/perf/shaders.mjs [.perf/trace-first.json] [отметка]
import { readFileSync } from "node:fs";
import { out } from "./driver.mjs";
const { traceEvents: ev } = JSON.parse(readFileSync(process.argv[2] ?? out("trace-first.json"), "utf8"));
const markName = process.argv[3] ?? "перед кликом";
const mark = ev.find((e) => e.name === markName)?.ts ?? 0;
const short = (n) => n.replace(/virtual |__cdecl |\(anonymous namespace\)::|skgpu::ganesh::|sk_sp<\w+> |\(.*$/g, "").trim();
const sk = ev.filter((e) => /skia/.test(e.cat || "") && e.ph === "X");
const fin = sk.filter((e) => /GrGLProgramBuilder::finalize/.test(e.name)).sort((a, b) => a.ts - b.ts);
const before = fin.filter((e) => e.ts < mark);
console.log(`до отметки «${markName}»: ${before.length} программ, ${Math.round(before.reduce((a, e) => a + e.dur, 0) / 1000)} мс`);
// Кто попросил: растр содержимого страницы (Raster) или компоновка кадра (Display)
const tops = ev.filter((e) => e.ph === "X" && /DoEndRasterCHROMIUM$|FinishPaintRenderPass|SwapBuffers|CopyOutput|DoCommands/.test(e.name));
const topOf = (f) => {
  const t = tops.find((e) => e.pid === f.pid && e.tid === f.tid && e.ts <= f.ts && e.ts + e.dur >= f.ts + f.dur);
  return !t ? "?" : /Raster/.test(t.name) ? "растр" : "компоновка";
};
let total = 0;
for (const f of fin.filter((e) => e.ts >= mark)) {
  const parents = sk
    .filter((e) => e !== f && e.pid === f.pid && e.tid === f.tid && e.ts <= f.ts && e.ts + e.dur >= f.ts + f.dur && !/GrGLProgram|OpsTask|GrDrawingManager|flushSurfaces|executeFlushInfo|GrGpu::/.test(e.name))
    .sort((a, b) => a.dur - b.dur);
  total += f.dur;
  console.log(`${Math.round((f.ts - mark) / 1000)} мс  +${(f.dur / 1000).toFixed(1)}  ${topOf(f)}  ${parents.slice(0, 3).map((p) => short(p.name)).join(" < ") || "?"}`);
}
console.log(`после отметки: ${Math.round(total / 1000)} мс компиляции`);
