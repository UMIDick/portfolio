// Шаги фоновой подготовки (requestIdleCallback), таймеры и исполнение скриптов дольше порога —
// с вложенными событиями: функции, GL-вызовы (ожидание GPU), сборка мусора.
// node --max-old-space-size=8000 scripts/perf/idle2.mjs [.perf/trace-A.json] [порог мс]
import { readFileSync } from "node:fs";
import { out } from "./driver.mjs";
const [file = out("trace-A.json"), minS = "8"] = process.argv.slice(2);
const { traceEvents: ev } = JSON.parse(readFileSync(file, "utf8"));
const threads = new Map();
for (const e of ev) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
let t0 = Infinity; for (const e of ev) if (e.ts > 0 && e.ts < t0) t0 = e.ts;
const main = ev.filter((e) => e.ph === "X" && threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain").sort((a, b) => a.ts - b.ts);
const cbs = main.filter((e) => (e.name === "FireIdleCallback" || e.name === "TimerFire" || e.name === "EvaluateScript" || e.name === "FunctionCall") && e.dur / 1000 >= Number(minS));
const outer = cbs.filter((e) => !cbs.some((o) => o !== e && o.ts <= e.ts && o.ts + o.dur >= e.ts + e.dur && (o.ts < e.ts || o.dur > e.dur)));
for (const cb of outer) {
  const a = cb.args?.data ?? {};
  console.log(`\n${Math.round((cb.ts - t0) / 1000)}ms ${cb.name} ${(cb.dur / 1000).toFixed(1)}ms ${a.functionName ? a.functionName + "@" + (a.url || "").split("/").pop() : a.url ? (a.url + "").split("/").pop() : ""}`);
  const inside = main.filter((e) => e !== cb && e.ts >= cb.ts && e.ts + e.dur <= cb.ts + cb.dur && e.dur / 1000 >= 0.7 && !/^(RunMicrotasks|AsyncTask Run|FunctionCall)$/.test(e.name));
  const agg = new Map();
  for (const e of inside) { const d = e.args?.data ?? {}; const k = e.name + (d.functionName ? `[${d.functionName}]` : d.url ? `[${(d.url + "").split("/").pop()}]` : ""); agg.set(k, (agg.get(k) ?? 0) + e.dur); }
  console.log("   " + [...agg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(" · "));
  const fns = main.filter((e) => e.name === "FunctionCall" && e.ts >= cb.ts && e.ts + e.dur <= cb.ts + cb.dur && e.dur / 1000 >= 2).map((e) => `${e.args?.data?.functionName || "?"}:${e.args?.data?.lineNumber}:${e.args?.data?.columnNumber} ${(e.dur / 1000).toFixed(1)}`);
  if (fns.length) console.log("   fn: " + fns.slice(0, 8).join(" · "));
}
