// Отчёт по .perf/prof.json (или файлу из аргумента): длинные кадры по фазам, с атрибуцией скриптов.
// Смотреть на «block» (заблокированный главный поток) и «пропуски rAF»; кадры с block 0 и без
// скриптов — ожидание GPU/компоновщика (на холодном профиле — компиляция шейдеров).
import { readFileSync } from "node:fs";
import { out } from "./driver.mjs";
const p = JSON.parse(readFileSync(process.argv[2] ?? out("prof.json"), "utf8"));
const marks = p.marks;
const phaseOf = (t) => {
  let name = "(до первой отметки)";
  for (const m of marks) if (m.t <= t) name = m.name; else break;
  // фаза = отрезок до следующей отметки → называем её по следующей
  const i = marks.findIndex((m) => m.t > t);
  return i >= 0 ? `…→ ${marks[i].name}` : `после «${name}»`;
};
const byPhase = new Map();
const add = (t, item) => {
  const k = phaseOf(t);
  if (!byPhase.has(k)) byPhase.set(k, { loaf: [], gaps: [], events: [] });
  byPhase.get(k)[item.kind].push(item);
};
for (const e of p.loaf) add(e.start, { kind: "loaf", ...e });
for (const g of p.gaps) add(g.t, { kind: "gaps", ...g });
for (const e of p.events) add(e.start, { kind: "events", ...e });
const fmt = (n) => Math.round(n);
let order = marks.map((m) => `…→ ${m.name}`);
order.unshift("(до первой отметки)");
order.push(`после «${marks.at(-1)?.name}»`);
for (const k of order) {
  const v = byPhase.get(k);
  if (!v) continue;
  const worstGap = Math.max(0, ...v.gaps.map((g) => g.gap));
  const worstLoaf = Math.max(0, ...v.loaf.map((l) => l.dur));
  console.log(`\n${k}   loaf:${v.loaf.length} (max ${fmt(worstLoaf)}ms)  пропуски rAF:${v.gaps.length} (max ${worstGap}ms)`);
  for (const l of v.loaf.sort((a, b) => b.dur - a.dur).slice(0, 6)) {
    const scripts = l.scripts
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 3)
      .map((s) => `${s.src}:${s.fn || s.name}(${fmt(s.dur)}ms${s.forced ? `, forced ${fmt(s.forced)}` : ""})`)
      .join(", ");
    console.log(`   ${fmt(l.dur)}ms @${fmt(l.start)}  block ${fmt(l.block)}  render ${fmt(l.render)} style/layout ${fmt(l.styleLayout)}  ${scripts}`);
  }
  const gaps = v.gaps.filter((g) => g.gap > 34).sort((a, b) => b.gap - a.gap).slice(0, 8);
  if (gaps.length) console.log("   rAF>34:", gaps.map((g) => `${g.gap}@${fmt(g.t)}`).join(" "));
  const ev = v.events.sort((a, b) => b.dur - a.dur).slice(0, 4);
  if (ev.length) console.log("   события:", ev.map((e) => `${e.name} ${fmt(e.dur)}ms (delay ${fmt(e.delay)})`).join(", "));
}
