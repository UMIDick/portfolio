/**
 * Макет на весь экран и обратно: интервалы между кадрами (rAF) при открытии и закрытии.
 * SLUG — проект (по умолчанию school), ZOOM=1 — перед закрытием приблизить колесом и повернуть,
 * SHOT=1 — снимки .perf/full-open.png и .perf/full-closed.png.
 */
import { writeFileSync } from "node:fs";
import { launch, sleep, W, H, out } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SLUG = process.env.SLUG ?? "school";
const d = await launch();
const shot = async (name) => {
  if (!process.env.SHOT) return;
  const { data } = await d.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out(name), Buffer.from(data, "base64"));
};
/** Интервалы кадров за время действия: сколько кадров, худшие, сумма сверх 17 мс. */
const frames = async (name, act, ms) => {
  await d.evaluate(`window.__f = []; window.__run = true; (function loop(prev) { requestAnimationFrame((t) => { if (prev) window.__f.push(t - prev); if (window.__run) loop(t); }); })(0); 1`);
  await act();
  await sleep(ms);
  const f = JSON.parse(await d.evaluate(`window.__run = false, JSON.stringify(window.__f)`));
  const worst = [...f].sort((a, b) => b - a).slice(0, 6).map((v) => Math.round(v));
  // Где по времени стоят долгие кадры (мс от начала записи)
  let at = 0;
  const long = [];
  for (const v of f) { at += v; if (v > 25) long.push(`${Math.round(v)}@${Math.round(at - v)}`); }
  console.log(`${name}: кадров ${f.length}, худшие ${worst.join(" ")} мс, дольше 25 мс — ${long.join(" ") || "нет"}`);
};

await d.navigate(`${BASE}/projects/${SLUG}`);
await sleep(7000);
const m = await d.rect("[data-model-hit], [class*='hit']");
if (!m) throw new Error("макет не найден");
await frames("открытие", () => d.click(m.x, m.y), 1400);
await shot("full-open.png");
if (process.env.ZOOM) {
  await d.wheel(W / 2, H / 2, -120, 4);
  await d.mouse("mousePressed", W / 2, H / 2, { button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await d.mouse("mouseMoved", W / 2 + i * 25, H / 2 - i * 20, { button: "left", buttons: 1 }); await sleep(16); }
  await d.mouse("mouseReleased", W / 2 + 250, H / 2 - 200, { button: "left", clickCount: 1 });
  await sleep(800);
}
await frames("закрытие", () => d.key("Escape", "Escape", 27), 2600);
await shot("full-closed.png");
// Макет после посадки снова крутится: второй снимок чуть позже должен отличаться
await sleep(2500);
await shot("full-closed-2.png");
d.close();
