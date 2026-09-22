// Кадры конвейера компоновщика (PipelineReporter): пропущенные и долгие кадры по фазам, с самой долгой стадией.
// node --max-old-space-size=8000 scripts/perf/frames.mjs [.perf/trace-B.json] [порог мс] [префикс отметок]
import { readFileSync } from "node:fs";
import { out } from "./driver.mjs";
const [file = out("trace-B.json"), minS = "30", pfx = ""] = process.argv.slice(2);
const { traceEvents: ev } = JSON.parse(readFileSync(file, "utf8"));
let t0 = Infinity; for (const e of ev) if (e.ts > 0 && e.ts < t0) t0 = e.ts;
const ms = (us) => Math.round((us - t0) / 1000);
const marks = ev.filter((e) => e.cat?.includes("user_timing") && ["I","R","n"].includes(e.ph) && e.name.startsWith(pfx) && !/^(navigation|dom|load|fetch|response|unload|commit|first)/.test(e.name)).map((e) => ({ name: e.name, ts: e.ts })).sort((a, b) => a.ts - b.ts);
const phaseAt = (ts) => { const i = marks.findIndex((m) => m.ts > ts); return i >= 0 ? `…→ ${marks[i].name}` : `после «${marks.at(-1)?.name}»`; };
// async-события: b/e по id
const open = new Map(); const spans = [];
for (const e of ev) {
  if (!e.cat?.includes("benchmark") && !e.cat?.includes("cc")) continue;
  if (e.ph === "b") open.set(`${e.id}:${e.name}:${e.pid}`, e);
  else if (e.ph === "e") { const k = `${e.id}:${e.name}:${e.pid}`; const b = open.get(k); if (b) { spans.push({ ...b, dur: e.ts - b.ts, endArgs: e.args }); open.delete(k); } }
}
const reporters = spans.filter((s) => s.name === "PipelineReporter");
const stagesOf = (r) => spans.filter((s) => s.id === r.id && s.pid === r.pid && s.name !== "PipelineReporter" && s.ts >= r.ts && s.ts + s.dur <= r.ts + r.dur + 1);
const byPhase = new Map();
for (const r of reporters) {
  const st = r.endArgs?.chrome_frame_reporter?.state ?? r.args?.chrome_frame_reporter?.state ?? "?";
  const ph = phaseAt(r.ts);
  if (!byPhase.has(ph)) byPhase.set(ph, { n: 0, dropped: 0, long: [] });
  const p = byPhase.get(ph); p.n++;
  if (st.includes("DROPPED")) p.dropped++;
  if (r.dur / 1000 >= Number(minS)) {
    const stages = stagesOf(r).sort((a, b) => b.dur - a.dur).slice(0, 3).map((s) => `${s.name} ${(s.dur / 1000).toFixed(0)}`);
    p.long.push(`${(r.dur / 1000).toFixed(0)}ms@${ms(r.ts)} ${st.replace("STATE_", "")} [${stages.join("; ")}]`);
  }
}
console.log("отметки:", marks.map((m) => `${m.name}@${ms(m.ts)}`).join(" | "));
for (const [ph, p] of byPhase) {
  console.log(`\n${ph}: кадров ${p.n}, пропущено ${p.dropped}, долгих (≥${minS}мс) ${p.long.length}`);
  for (const l of p.long.slice(0, 12)) console.log("   " + l);
}
