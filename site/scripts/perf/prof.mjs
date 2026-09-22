/**
 * Полный прогон сайта: экраны главной, открытие проекта, карусель, просмотр листа,
 * макет на весь экран, соседние проекты, возврат, кнопка «Назад».
 * Пишет .perf/prof.json; отчёт — `node scripts/perf/report.mjs` (npm run perf делает оба).
 * Сайт должен быть собран и запущен: npm run build && npm run start (BASE — адрес).
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const d = await launch();
const { mark, wheel, move, click, rect, clickSel, key, evaluate } = d;
const path_ = () => evaluate("location.pathname + location.hash");

await d.navigate(BASE + "/");
await sleep(4500);
await mark("home: интро сыграло");
await wheel(W / 2, H / 2, 120); await sleep(1600); await mark("home: → резюме");
await sleep(2500);
await wheel(W / 2, H / 2, 120); await sleep(1600); await mark("home: → проекты");
await sleep(5200);
await mark("home: карточки на местах, предзагрузка");
await wheel(W / 2, H / 2, 120); await sleep(1600); await mark("home: → контакты");
await wheel(W / 2, H / 2, -120); await sleep(1600); await mark("home: ← проекты");
await sleep(1500);

const card = await rect('a[href="/projects/flat"]');
await move(card.x, card.y); await sleep(1200); await mark("hover flat");
await click(card.x, card.y);
await sleep(1500); await mark("proj-open: переход (1.5с)");
await sleep(4500); await mark("proj-open: макет построен");
console.log("  path", await path_());

const track = await rect('ul[class*="track"]');
await wheel(track.x, track.y, 100, 4, 500); await sleep(800); await mark("карусель: 4 листа вперёд");
await wheel(track.x, track.y, -100, 2, 500); await sleep(800); await mark("карусель: 2 назад");
await clickSel('ul[class*="track"] li:nth-child(2) button'); await sleep(900); await mark("лист: открыт");
await key("ArrowRight", "ArrowRight", 39); await sleep(500);
await key("Escape", "Escape", 27); await sleep(700); await mark("лист: закрыт");

await wheel(W / 2, 200, 120); await sleep(1600); await mark("proj: → overview");
await wheel(W / 2, 200, -120); await sleep(1600); await mark("proj: ← первый экран");

const hit = await rect('div[class*="hit"]');
await click(hit.x, hit.y); await sleep(1300); await mark("макет: на весь экран");
await wheel(W / 2, H / 2, -100, 5, 80); await sleep(700); await mark("макет: приближение");
await d.mouse("mousePressed", W / 2, H / 2, { button: "left", clickCount: 1 });
for (let i = 1; i <= 20; i++) {
  await d.mouse("mouseMoved", W / 2 + i * 12, H / 2 + i * 3, { button: "left", buttons: 1 });
  await sleep(16);
}
await d.mouse("mouseReleased", W / 2 + 240, H / 2 + 60, { button: "left", clickCount: 1 });
await sleep(600); await mark("макет: вращение");
await key("Escape", "Escape", 27); await sleep(1300); await mark("макет: закрыт");

await clickSel('a[data-nav="proj-next"]'); await sleep(1500); await mark("proj-next: переход");
await sleep(5000); await mark("proj-next: макет построен");
console.log("  path", await path_());
await clickSel('a[data-nav="proj-prev"]'); await sleep(1500); await mark("proj-prev: переход");
await sleep(5000); await mark("proj-prev: макет построен");
console.log("  path", await path_());

await clickSel('a[data-nav="proj-close"]'); await sleep(1500); await mark("proj-close: обратная анимация");
await sleep(2500); await mark("proj-close: на главной");
console.log("  path", await path_());

const card2 = await rect('a[href="/projects/tower"]');
await move(card2.x, card2.y); await sleep(600);
await click(card2.x, card2.y); await sleep(1500); await mark("proj-open #2: переход");
await sleep(4500); await mark("proj-open #2: макет построен");
await evaluate("history.back(), 1");
await sleep(4500); await mark("history.back: на главной");
console.log("  path", await path_());

await d.collect("prof.json");
d.close();
