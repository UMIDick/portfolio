/** Отладка: тап по соседнему проекту после цикла полноэкранного макета. */
import { launch, sleep, MW, MH } from "./driver.mjs";

process.env.MOBILE ??= "1";
const d = await launch();
const { tap, swipe, pinch, twoFingerPan, rect, evaluate } = d;

await d.navigate("http://localhost:3000/projects/school");
await sleep(6500);
await evaluate(`window.__clicks = []; document.addEventListener("click", (e) => window.__clicks.push({ t: Math.round(performance.now()), tag: e.target.tagName, cls: String(e.target.className).slice(0, 40), def: e.defaultPrevented }), true), 1`);

const hit = await rect('div[class*="hit"]');
console.log("hit:", JSON.stringify(hit));
await tap(hit.x, hit.y);
await sleep(1500);
console.log("диалог открыт:", await evaluate(`!!document.querySelector("dialog[open]")`));
await pinch(MW / 2, MH / 2, 100, 300);
await sleep(300);
await twoFingerPan(MW / 2, MH / 2, 120, -80, -60);
await sleep(300);
await swipe(MW / 2, MH / 2, 140, 40, { fling: true });
await sleep(300);
await tap(MW / 2, MH / 2);
await sleep(2500);
console.log("диалог открыт после закрытия:", await evaluate(`!!document.querySelector("dialog[open]")`));
console.log("клики:", await evaluate("JSON.stringify(window.__clicks)"));

for (let i = 0; i < 12; i++) {
  const r = await evaluate(`(() => { for (const el of document.querySelectorAll('a[data-nav="proj-next"]')) {
    const b = el.getBoundingClientRect(); if (b.width && b.top >= 0 && b.bottom <= innerHeight) {
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, inLink: !!(hit && hit.closest('a[data-nav="proj-next"]')), hit: hit && (hit.tagName + "." + String(hit.className).slice(0, 40)) };
    } } return null; })()`);
  if (r) {
    console.log("нашёл:", JSON.stringify(r));
    await tap(r.x, r.y);
    await sleep(4500);
    console.log("клики:", await evaluate("JSON.stringify(window.__clicks)"));
    console.log("после тапа:", await evaluate("location.pathname"));
    break;
  }
  await swipe(MW / 2, MH * 0.72, 0, -MH * 0.55);
  await sleep(400);
}
d.close();
