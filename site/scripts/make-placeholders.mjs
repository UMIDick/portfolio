/**
 * Генерирует листы-заглушки формата А3 (альбомная ориентация) для трёх проектов
 * и записывает описания листов в `content/sheets/<slug>.json`.
 *
 * Запуск: `npm run placeholders`
 *
 * Когда заказчик пришлёт реальные чертежи, положите их в
 * `public/projects/<slug>/sheets/` и обновите `content/sheets/<slug>.json`
 * (номер, название, путь, размеры) — либо это сделает будущая админка.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const W = 1684; // А3 420 мм при ~102 dpi
const H = 1191; // А3 297 мм

// Заглушки только для проектов без настоящих чертежей (flat и school — `npm run sheets`).
const TITLES = {
  flat: [
    "Общие данные", "Обмерный план", "План демонтажа перегородок", "План монтажа перегородок",
    "Планировочное решение", "План расстановки мебели", "План полов", "План потолков",
    "План размещения светильников", "Схема выключателей", "План розеток", "План слаботочных сетей",
    "План тёплых полов", "План водоснабжения и канализации", "Развёртка стен. Гостиная", "Развёртка стен. Спальня",
    "Развёртка стен. Кухня", "Развёртка стен. Санузел", "Узлы. Потолки", "Узлы. Полы",
    "Ведомость дверных проёмов", "Ведомость отделки помещений", "Спецификация светильников", "Экспликация помещений",
  ],
  school: [
    "Общие данные", "Генеральный план", "План 1-го этажа", "План 2-го этажа",
    "План кровли", "Фасад 1–7", "Фасад 7–1", "Фасад А–Д",
    "Разрез 1–1", "Разрез 2–2", "Схема расположения перемычек", "Ведомость заполнения проёмов",
    "Узлы кровли", "Узлы цоколя", "Экспликация помещений",
  ],
  tower: [
    "Общие данные", "План 1-го этажа", "План типового этажа", "План технического этажа",
    "План кровли", "Фасад 1–8", "Фасад А–Г", "Разрез 1–1",
    "Схема расположения лестниц", "Узлы наружных стен",
  ],
};

const PROJECTS = JSON.parse(await readFile(path.join(ROOT, "content/projects.json"), "utf8"));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * «Миллиметровка»: крупные клетки ~120 px и по 5 мелких в каждой.
 * Шаг подгоняется, чтобы клетки ровно укладывались в область без обрезков.
 */
function gridSvg({ x, y, w, h, ink }) {
  const cols = Math.round(w / 120) * 5;
  const rows = Math.round(h / 120) * 5;
  const lines = (major) => {
    let d = "";
    for (let i = 1; i < cols; i++) {
      if ((i % 5 === 0) !== major) continue;
      const lx = (x + (w * i) / cols).toFixed(2);
      d += `M${lx} ${y}V${y + h}`;
    }
    for (let j = 1; j < rows; j++) {
      if ((j % 5 === 0) !== major) continue;
      const ly = (y + (h * j) / rows).toFixed(2);
      d += `M${x} ${ly}H${x + w}`;
    }
    return d;
  };
  return `<g fill="none" stroke="${ink}">
    <path d="${lines(false)}" stroke-width="1" opacity=".07"/>
    <path d="${lines(true)}" stroke-width="1.2" opacity=".2"/>
  </g>`;
}

function sheetSvg({ number, title, projectTitle, total, ink, bg }) {
  const m = 40; // поле
  const stampW = 520, stampH = 150;
  const stampX = W - m - stampW, stampY = H - m - stampH;
  // Сетка заполняет внутреннюю рамку целиком
  const gx = m + 12, gy = m + 12, gw = W - 2 * m - 24, gh = H - 2 * m - 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="none" stroke="${ink}" stroke-width="3"/>
  <rect x="${m + 12}" y="${m + 12}" width="${W - 2 * m - 24}" height="${H - 2 * m - 24}" fill="none" stroke="${ink}" stroke-width="1" opacity=".45"/>
  <defs>
    <!-- Сетка плавно растворяется под названием листа -->
    <radialGradient id="fade">
      <stop offset="0.45" stop-color="#000"/>
      <stop offset="1" stop-color="#fff"/>
    </radialGradient>
    <mask id="grid-mask">
      <rect width="${W}" height="${H}" fill="#fff"/>
      <ellipse cx="${W / 2}" cy="${H / 2 - 10}" rx="680" ry="200" fill="url(#fade)"/>
    </mask>
  </defs>
  <g mask="url(#grid-mask)">
    ${gridSvg({ x: gx, y: gy, w: gw, h: gh, ink })}
  </g>
  <text x="${W / 2}" y="${H / 2 - 30}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="56" fill="${ink}" opacity=".9">${esc(title)}</text>
  <text x="${W / 2}" y="${H / 2 + 34}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="26" letter-spacing="4" fill="${ink}" opacity=".55">ЛИСТ-ЗАГЛУШКА · ЧЕРТЁЖ БУДЕТ ЗАМЕНЁН</text>
  <g stroke="${ink}" stroke-width="2" fill="none">
    <rect x="${stampX}" y="${stampY}" width="${stampW}" height="${stampH}" fill="${bg}"/>
    <line x1="${stampX}" y1="${stampY + 50}" x2="${stampX + stampW}" y2="${stampY + 50}"/>
    <line x1="${stampX}" y1="${stampY + 100}" x2="${stampX + stampW}" y2="${stampY + 100}"/>
    <line x1="${stampX + 360}" y1="${stampY + 50}" x2="${stampX + 360}" y2="${stampY + stampH}"/>
    <line x1="${stampX + 440}" y1="${stampY + 100}" x2="${stampX + 440}" y2="${stampY + stampH}"/>
  </g>
  <g font-family="system-ui, sans-serif" fill="${ink}">
    <text x="${stampX + 16}" y="${stampY + 33}" font-size="24">${esc(projectTitle)}</text>
    <text x="${stampX + 16}" y="${stampY + 83}" font-size="22">${esc(title)}</text>
    <text x="${stampX + 16}" y="${stampY + 133}" font-size="18" opacity=".7">Умид Шамсиддинов · рабочие чертежи</text>
    <text x="${stampX + 372}" y="${stampY + 70}" font-size="14" opacity=".7">Стадия</text>
    <text x="${stampX + 372}" y="${stampY + 92}" font-size="20">Р</text>
    <text x="${stampX + 372}" y="${stampY + 120}" font-size="14" opacity=".7">Лист</text>
    <text x="${stampX + 372}" y="${stampY + 142}" font-size="20">${number}</text>
    <text x="${stampX + 452}" y="${stampY + 120}" font-size="14" opacity=".7">Листов</text>
    <text x="${stampX + 452}" y="${stampY + 142}" font-size="20">${total}</text>
  </g>
</svg>`;
}

await mkdir(path.join(ROOT, "content/sheets"), { recursive: true });

const REAL = new Set(["flat", "school"]);

for (const p of PROJECTS.filter((p) => !REAL.has(p.slug))) {
  const [from, to] = p.sheetRange;
  const titles = TITLES[p.slug] ?? [];
  const dir = path.join(ROOT, "public/projects", p.slug, "sheets");
  await mkdir(dir, { recursive: true });
  const sheets = [];
  const total = to - from + 1;
  for (let n = from; n <= to; n++) {
    const title = titles[n - from] ?? `Лист ${n}`;
    const file = `${String(n).padStart(2, "0")}.svg`;
    await writeFile(
      path.join(dir, file),
      sheetSvg({ number: n, title, projectTitle: p.title, total, ink: p.palette.ink, bg: p.palette.bg }),
    );
    sheets.push({ number: n, title, src: `/projects/${p.slug}/sheets/${file}`, width: W, height: H });
  }
  await writeFile(path.join(ROOT, "content/sheets", `${p.slug}.json`), JSON.stringify(sheets, null, 2) + "\n");
  console.log(`${p.slug}: ${sheets.length} листов (${from}–${to})`);
}
