/**
 * Проверка навигации по главной (не замер): кнопки-якоря листают так же, как колесо
 * (ScreenPager, ~1 с), общая кнопка со стрелкой (NextCta) не пропадает при перелистывании,
 * каскады разделов после возврата со страницы проекта не играют заново (Stagger once).
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const d = await launch();
const cta = () =>
  d.evaluate(`(() => { const a = document.querySelector('a[class*="cta"]:not(.gpu-warm *)');
    return a ? { href: a.getAttribute("href"), opacity: +getComputedStyle(a).opacity, hidden: a.hasAttribute("data-hidden") } : null; })()`);
const reveals = () =>
  d.evaluate(`JSON.stringify([...document.querySelectorAll("[data-stagger]")].filter((e) => !e.closest(".gpu-warm")).map((e) => e.dataset.reveal))`);
/** Сколько длится прокрутка после действия, мс. */
const scrollTime = async (act) => {
  await d.evaluate(`window.__s = []; window.__on = () => window.__s.push(performance.now()); addEventListener("scroll", window.__on); 1`);
  await act();
  await sleep(1600);
  return d.evaluate(`removeEventListener("scroll", window.__on), Math.round(window.__s.at(-1) - window.__s[0])`);
};

await d.navigate(BASE + "/");
await sleep(3200);
console.log("кнопка «Резюме»: прокрутка", await scrollTime(() => d.clickSel('a[href="#resume"]')), "мс");
console.log("  экран", await d.evaluate("scrollY / innerHeight"), "кнопка", await cta());
await sleep(10500);
console.log("после каскада резюме: кнопка", await cta());
console.log("колесо → проекты: прокрутка", await scrollTime(() => d.wheel(W / 2, H / 2, 120)), "мс; кнопка сразу после:", await cta());
console.log("кнопка со стрелкой → контакты: прокрутка", await scrollTime(() => d.clickSel('a[class*="cta"]:not(.gpu-warm *)')), "мс");
console.log("  экран", await d.evaluate("scrollY / innerHeight"), "кнопка", await cta(), "хеш", await d.evaluate("location.hash"));
await d.key("PageUp", "PageUp", 33);
await sleep(1500);
console.log("каскады до ухода:", await reveals());
await d.clickSel('a[href="/projects/flat"]');
await sleep(4000);
await d.clickSel('a[data-nav="proj-close"]');
await sleep(4000);
console.log("вернулись:", await d.evaluate("location.pathname + location.hash"), "каскады:", await reveals(), "кнопка", await cta());
d.close();
