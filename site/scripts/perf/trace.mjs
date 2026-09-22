/**
 * Трассировки Chrome (категории devtools/cc/gpu/viz/benchmark) для двух сценариев:
 * A — загрузка главной и перелистывание экранов; B — страница проекта (открытие,
 * макет, карусель, лист, соседний проект, возврат). SCEN=A|B|AB (по умолчанию AB).
 * Разбор: analyze.mjs (задачи главного потока), frames.mjs (кадры конвейера),
 * idle2.mjs (шаги фоновой подготовки). Файлы по 200–400 МБ, лежат в .perf.
 */
import { launch, sleep, W, H } from "./driver.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const which = process.env.SCEN ?? "AB";
const d = await launch();

if (which.includes("A")) {
  await d.traceStart();
  await d.navigate(BASE + "/");
  await sleep(4500);
  await d.mark("A: интро сыграло");
  await d.wheel(W / 2, H / 2, 120); await sleep(1500); await d.mark("A: → резюме");
  await sleep(2000);
  await d.wheel(W / 2, H / 2, 120); await sleep(1500); await d.mark("A: → проекты");
  await sleep(4000);
  await d.wheel(W / 2, H / 2, 120); await sleep(1500); await d.mark("A: → контакты");
  await d.wheel(W / 2, H / 2, -120); await sleep(1500); await d.mark("A: ← проекты");
  await d.traceStop("trace-A.json");
  await d.collect("prof-A.json");
} else {
  await d.navigate(BASE + "/#projects");
  await sleep(6000);
}

if (which.includes("B")) {
  await sleep(1500);
  const card = await d.rect('a[href="/projects/flat"]');
  await d.move(card.x, card.y);
  await sleep(1500);
  await d.traceStart();
  await d.mark("B: клик по карточке");
  await d.click(card.x, card.y);
  await sleep(1500); await d.mark("B: переход сыграл");
  await sleep(4500); await d.mark("B: макет построен");
  const hit = await d.rect('div[class*="hit"]');
  await d.click(hit.x, hit.y); await sleep(1300); await d.mark("B: макет на весь экран");
  await d.key("Escape", "Escape", 27); await sleep(1300); await d.mark("B: макет закрыт");
  const track = await d.rect('ul[class*="track"]');
  await d.wheel(track.x, track.y, 100, 4, 500); await sleep(600); await d.mark("B: карусель 4 вперёд");
  await d.wheel(track.x, track.y, -100, 3, 500); await sleep(600); await d.mark("B: карусель 3 назад");
  await d.clickSel('ul[class*="track"] li:nth-child(2) button'); await sleep(900); await d.mark("B: лист открыт");
  await d.key("ArrowRight", "ArrowRight", 39); await sleep(500);
  await d.key("Escape", "Escape", 27); await sleep(800); await d.mark("B: лист закрыт");
  await d.wheel(W / 2, 200, 120); await sleep(1500); await d.mark("B: → overview");
  await d.wheel(W / 2, 200, -120); await sleep(1500); await d.mark("B: ← экран 1");
  await d.clickSel('a[data-nav="proj-next"]'); await sleep(1500); await d.mark("B: proj-next переход");
  await sleep(4500); await d.mark("B: proj-next макет");
  await d.clickSel('a[data-nav="proj-close"]'); await sleep(1500); await d.mark("B: proj-close обратная анимация");
  await sleep(2500); await d.mark("B: на главной");
  await d.traceStop("trace-B.json");
  await d.collect("prof-B.json");
}
d.close();
