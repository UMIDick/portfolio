/**
 * Перезагрузка на экране проектов: кнопка «Резюме» → колесом к проектам → F5.
 * Проверяет, что после перезагрузки остаёмся на том же экране (адрес следует за экраном —
 * ScreenPager), и пишет кадры каскада карточек сразу после загрузки (.perf/first.json).
 * SHOT=1 — снимок экрана .perf/reload.png.
 */
import { writeFileSync } from "node:fs";
import { launch, sleep, W, H, out } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const d = await launch();
await d.navigate(BASE + "/");
await sleep(3000);
await d.clickSel('a[href="#resume"]');
await sleep(1800);
await d.wheel(W / 2, H / 2, 120);
await sleep(2000);
const state = () => d.evaluate("JSON.stringify({ hash: location.hash, screen: Math.round(scrollY / innerHeight * 100) / 100 })");
console.log("  до перезагрузки  ", await state());
await d.send("Page.reload");
await sleep(1200); await d.mark("перезагрузка: шапка");
await sleep(5500); await d.mark("перезагрузка: карточки на местах");
console.log("  после перезагрузки", await state());
if (process.env.SHOT) {
  const { data } = await d.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out("reload.png"), Buffer.from(data, "base64"));
}
await d.collect("first.json");
d.close();
