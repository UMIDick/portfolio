/**
 * Детальный 3D-макет музыкальной школы → public/projects/school/model.glb (+ model.json).
 *
 * План (стены, проёмы, мебель, кресла, силуэт) — scripts/data/school-plan.json
 * (scripts/extract-school.py). Всё остальное — по листам альбома АР:
 * отметки этажей и кровли (фасады, разрез 9–3), окна фасадов (листы 12–13),
 * лестницы, зал (лист 10), фонари и техбоксы на кровле (взрыв-схема, лист 11).
 *
 * Модель строится в метрах (x — на восток от оси 1, y — вверх, z — на юг от оси З),
 * затем переводится в координаты карточки (transform из school-plan.json) и
 * записывается в GLB: по одному мешу на материал, плюс линии рёбер и деталей.
 * Нормалей в файле нет — макет рисуется плоскими гранями (flatShading).
 *
 * Запуск: node scripts/make-school-model.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const plan = JSON.parse(readFileSync(new URL("./data/school-plan.json", import.meta.url), "utf8"));
const OUT_DIR = new URL("../public/projects/school/", import.meta.url);

// ── Отметки, м ──
const PLATE = 0.1; // пол 1-го этажа над карточкой
const F1 = 4.8; // 2-й этаж (разрез 9–3)
const F2 = 10.0; // 3-й этаж
const SLAB = 0.35;
const ROOF = 17.0; // верх кровельной плиты
const PARAPET = 17.6; // верх фасадов северного блока и зала
const DOOR = 2.3;
// Кровля круглого объёма почти вровень с краем (титул, аксонометрии)
const ROUND = { soffit: 4.8, floor: 5.1, roof: 18.2, top: 18.73 };
// Кровля атриума — ступень выше основной (фасад 1: +18.2 у атриума)
const ROOF_HIGH = 17.6;
const ATRIUM_TOP = 18.2;
const HALL = { stage: 0.96, balcony: 7.137, gallery: 10.0, truss0: 14.4, truss1: 16.7 };
const FIN_FROM = 5.1; // плавники зала начинаются над цоколем (фасад 1)

const AX = plan.axes.x;
const AZ = plan.axes.z;
const faces = plan.faces;

// ── Корзины по материалам ──
const solids = new Map(); // материал → BufferGeometry[]
const edgePos = []; // рёбра объёмов
const linePos = []; // тонкие детали: переплёты, ограждения, ламели

const addSolid = (mat, geo, edgeAngle = 30) => {
  if (!solids.has(mat)) solids.set(mat, []);
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  solids.get(mat).push(g);
  if (edgeAngle) {
    const e = new THREE.EdgesGeometry(geo, edgeAngle);
    edgePos.push(...e.attributes.position.array);
    e.dispose();
  }
  if (g !== geo) geo.dispose();
};
const line = (a, b) => linePos.push(a[0], a[1], a[2], b[0], b[1], b[2]);

// ── Примитивы (плоскость плана: [x, z]) ──
const shapeOf = (poly) => {
  const s = new THREE.Shape(poly.outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  s.holes = (poly.holes ?? []).map((h) => new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
};
const prism = (polys, y0, y1) => {
  const g = new THREE.ExtrudeGeometry((Array.isArray(polys) ? polys : [polys]).map(shapeOf), {
    depth: y1 - y0,
    bevelEnabled: false,
    curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
};
const ring = (pts) => ({ outer: pts, holes: [] });
const box = (x0, x1, y0, y1, z0, z1) => {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len2 = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / (len2(a) || 1));
/** Левая нормаль направления (на плане z вниз). */
const perp = (d) => [d[1], -d[0]];

/** Брус вдоль отрезка p0→p1: ширина w поперёк, со сдвигом off по нормали perp(d). */
const beam = (p0, p1, w, y0, y1, off = 0) => {
  const d = sub(p1, p0);
  const L = len2(d);
  const g = new THREE.BoxGeometry(L, y1 - y0, w);
  g.rotateY(-Math.atan2(d[1], d[0]));
  const n = perp(unit(d));
  const c = add2(mul(add2(p0, p1), 0.5), mul(n, off));
  g.translate(c[0], (y0 + y1) / 2, c[1]);
  return g;
};

/** Стержень между точками [x, y, z]. */
const rod = (a, b, r, seg = 6) => {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const dir = B.clone().sub(A);
  const g = new THREE.CylinderGeometry(r, r, dir.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  const m = A.add(B).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
};

/** Отсечение многоугольника полуплоскостью a·x + b·z <= c (Сазерленд — Ходжмен). */
const clipHalf = (pts, a, b, c) => {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const P = pts[i];
    const Q = pts[(i + 1) % pts.length];
    const fp = a * P[0] + b * P[1] - c;
    const fq = a * Q[0] + b * Q[1] - c;
    if (fp <= 0) out.push(P);
    if (fp * fq < 0) {
      const t = fp / (fp - fq);
      out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
    }
  }
  return out;
};
const clipBand = (pts, z0, z1) => clipHalf(clipHalf(pts, 0, -1, -z0), 0, 1, z1);

const pointInPoly = (p, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

/** Пересечение луча p + t·d с контуром: наименьшее t > 0. */
const rayHit = (p, d, pts) => {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const e = sub(b, a);
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) continue;
    const w = sub(a, p);
    const t = (w[0] * e[1] - w[1] * e[0]) / den;
    const s = (w[0] * d[1] - w[1] * d[0]) / den;
    if (t > 1e-6 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best;
};

// ── Окна ──
/** Окно-«вставка» на поверхности стены: стекло чуть снаружи, рама, импост, отлив. */
const surfaceWindow = (p0, d, n, u0, u1, y0, y1, { proud = 0.06, mullions = 1 } = {}) => {
  const a = add2(add2(p0, mul(d, u0)), mul(n, proud));
  const b = add2(add2(p0, mul(d, u1)), mul(n, proud));
  addSolid("pane", beam(a, b, 0.04, y0, y1), 0);
  const A = add2(a, mul(n, 0.03));
  const B = add2(b, mul(n, 0.03));
  const P = (q, y) => [q[0], y, q[1]];
  line(P(A, y0), P(B, y0));
  line(P(A, y1), P(B, y1));
  line(P(A, y0), P(A, y1));
  line(P(B, y0), P(B, y1));
  for (let k = 1; k <= mullions; k++) {
    const q = add2(A, mul(sub(B, A), k / (mullions + 1)));
    line(P(q, y0), P(q, y1));
  }
  if (y1 - y0 > 1.6) {
    const yt = y0 + (y1 - y0) * 0.72;
    line(P(A, yt), P(B, yt));
  }
  // отлив
  addSolid("frame", beam(add2(a, mul(n, 0.04)), add2(b, mul(n, 0.04)), 0.14, y0 - 0.06, y0), 0);
};

/**
 * Стена вдоль отрезка с настоящими проёмами: holes — [{u0, u1, y0, y1}] (u — м от p0).
 * Стена толщиной t лежит по левую сторону от направления (сдвиг off).
 */
const wallWithHoles = (p0, p1, t, y0, y1, holes, mat, off = 0) => {
  const d = unit(sub(p1, p0));
  const L = len2(sub(p1, p0));
  const cuts = [...new Set([0, L, ...holes.flatMap((h) => [h.u0, h.u1])])]
    .filter((u) => u >= 0 && u <= L)
    .sort((a, b) => a - b);
  const at = (u) => add2(p0, mul(d, u));
  for (let i = 0; i + 1 < cuts.length; i++) {
    const ua = cuts[i];
    const ub = cuts[i + 1];
    if (ub - ua < 1e-3) continue;
    const mid = (ua + ub) / 2;
    const cover = holes.filter((h) => h.u0 <= mid && h.u1 >= mid).sort((a, b) => a.y0 - b.y0);
    let y = y0;
    for (const h of cover) {
      if (h.y0 > y + 1e-3) addSolid(mat, beam(at(ua), at(ub), t, y, h.y0, off), 0);
      y = Math.max(y, h.y1);
    }
    if (y1 > y + 1e-3) addSolid(mat, beam(at(ua), at(ub), t, y, y1, off), 0);
  }
  // Рёбра стены — контур и обрамления проёмов
  const P = (u, y, o) => {
    const q = add2(at(u), mul(perp(d), o));
    return [q[0], y, q[1]];
  };
  for (const o of [off - t / 2, off + t / 2]) {
    edgePos.push(...P(0, y0, o), ...P(L, y0, o), ...P(0, y1, o), ...P(L, y1, o));
    edgePos.push(...P(0, y0, o), ...P(0, y1, o), ...P(L, y0, o), ...P(L, y1, o));
    for (const h of holes) {
      edgePos.push(...P(h.u0, h.y0, o), ...P(h.u1, h.y0, o), ...P(h.u0, h.y1, o), ...P(h.u1, h.y1, o));
      edgePos.push(...P(h.u0, h.y0, o), ...P(h.u0, h.y1, o), ...P(h.u1, h.y0, o), ...P(h.u1, h.y1, o));
    }
  }
  // Стекло в проёмах с переплётами
  for (const h of holes) {
    addSolid("glass", beam(at(h.u0), at(h.u1), 0.03, h.y0, h.y1, off), 0);
    const w = h.u1 - h.u0;
    const cols = Math.max(1, Math.round(w / 1.2));
    for (let k = 1; k < cols; k++) {
      const u = h.u0 + (w * k) / cols;
      addSolid("frame", beam(at(u - 0.03), at(u + 0.03), 0.1, h.y0, h.y1, off), 0);
    }
    for (let y = h.y0 + 2.6; y < h.y1 - 0.5; y += 2.6) addSolid("frame", beam(at(h.u0), at(h.u1), 0.1, y - 0.03, y + 0.03, off), 0);
  }
};

// Полуэллиптический плавник-«гребёнка» (облицовка зала и круглого объёма)
const fin = (p, n, y0, y1, half = 0.46, depth = 0.4) => {
  const t = perp(n);
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const a = (Math.PI * i) / 8;
    pts.push(add2(add2(p, mul(t, half * Math.cos(a))), mul(n, depth * Math.sin(a) - 0.04)));
  }
  addSolid("dark", prism(ring(pts), y0, y1), 0);
  // Одна линия по гребню — рёбра по всем граням были бы слишком частыми
  const tip = add2(p, mul(n, depth - 0.03));
  edgePos.push(tip[0], y0, tip[1], tip[0], y1, tip[1]);
};

/** Ограждение: поручень, стойки и стеклянный экран вдоль ломаной (м, [x, z]). */
const railing = (pts, y, h = 1.1, glass = true) => {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    line([a[0], y + h, a[1]], [b[0], y + h, b[1]]);
    line([a[0], y + 0.1, a[1]], [b[0], y + 0.1, b[1]]);
    const L = len2(sub(b, a));
    const n = Math.max(1, Math.round(L / 1.2));
    for (let k = 0; k <= n; k++) {
      const q = add2(a, mul(sub(b, a), k / n));
      line([q[0], y, q[1]], [q[0], y + h, q[1]]);
    }
    if (glass && L > 0.05) addSolid("glass", beam(a, b, 0.02, y + 0.1, y + h - 0.05), 0);
  }
};

/** Марш лестницы: ступени коробками + наклонная плита снизу. */
const flight = (a, b, width, yA, yB, mat = "stair") => {
  const d = sub(b, a);
  const L = len2(d);
  const steps = Math.max(2, Math.round(Math.abs(yB - yA) / 0.17));
  const rise = (yB - yA) / steps;
  const run = L / steps;
  const du = unit(d);
  for (let k = 0; k < steps; k++) {
    const p = add2(a, mul(du, run * k));
    const q = add2(a, mul(du, run * (k + 1)));
    const top = yA + rise * (k + 1);
    addSolid(mat, beam(p, q, width, top - Math.abs(rise) - 0.04, top), 0);
  }
  // Косоуры (наклонные плиты по краям)
  const n = perp(du);
  for (const side of [-1, 1]) {
    const o = mul(n, (side * (width - 0.1)) / 2);
    const A = add2(a, o);
    const B = add2(b, o);
    const g = rod([A[0], yA - 0.15, A[1]], [B[0], yB - 0.15, B[1]], 0.08, 4);
    addSolid("stair", g, 0);
  }
  // Рёбра марша
  for (const side of [-1, 1]) {
    const o = mul(n, (side * width) / 2);
    const A = add2(a, o);
    const B = add2(b, o);
    edgePos.push(A[0], yA, A[1], B[0], yB, B[1]);
  }
  return { steps, rise };
};

// ═══════════════════ Сборка ═══════════════════

// ── Пол 1-го этажа (перекрывает иконку под зданием) ──
addSolid("floor", prism(plan.plate, 0, PLATE));

// ── Стены 1-го этажа ──
// Наружные стены — на всю высоту фасада; над проёмами перемычки
addSolid("wall", prism(plan.wallsOuter, PLATE, PARAPET), 50);
addSolid("wall", prism(plan.wallsInner, PLATE, F1 - SLAB));
addSolid("wall", prism(plan.wallsHall, PLATE, ROOF - SLAB));

for (const o of plan.openings) {
  const poly = ring(o.poly);
  if (o.kind === "inner") {
    addSolid("wall", prism(poly, DOOR, F1 - SLAB));
    continue;
  }
  const window = o.width > 1.6;
  const sill = window ? 0.8 : PLATE;
  const head = window ? 3.7 : 2.45;
  if (window) addSolid("wall", prism(poly, PLATE, sill));
  addSolid("wall", prism(poly, head, PARAPET));
  // Стекло по оси проёма
  const [p0, p1, p2, p3] = o.poly;
  const long = len2(sub(p1, p0)) > len2(sub(p2, p1));
  const a = long ? mul(add2(p0, p3), 0.5) : mul(add2(p0, p1), 0.5);
  const b = long ? mul(add2(p1, p2), 0.5) : mul(add2(p3, p2), 0.5);
  addSolid("glass", beam(a, b, 0.04, sill, head), 0);
  const L = len2(sub(b, a));
  const cols = Math.max(1, Math.round(L / 1.1));
  const du = unit(sub(b, a));
  for (let k = 0; k <= cols; k++) {
    const q = add2(a, mul(du, (L * k) / cols));
    addSolid("frame", beam(add2(q, mul(du, -0.04)), add2(q, mul(du, 0.04)), 0.12, sill, head), 0);
  }
  addSolid("frame", beam(a, b, 0.12, head - 0.08, head), 0);
  if (window) addSolid("frame", beam(a, b, 0.12, sill, sill + 0.06), 0);
}

// ── Мебель ──
for (const f of plan.furniture) {
  if (f.zone === "stage") addSolid("furn", prism(ring(f.poly), HALL.stage, HALL.stage + 1.0));
  else addSolid("furn", prism(ring(f.poly), PLATE, PLATE + 0.75));
}

// ── Перекрытия и верхние этажи ──
for (const lvl of [F1, F2]) {
  addSolid("slab", prism(plan.slabMid, lvl - SLAB, lvl));
  const top = lvl === F1 ? F2 - SLAB : ROOF - SLAB;
  addSolid("wall", prism(plan.wallsUpper, lvl, top));
}

// Галереи атриума: ограждение по краю перекрытий над атриумом
{
  const edge = [];
  for (const p of plan.slabMid) {
    const pts = p.outer;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const m = mul(add2(a, b), 0.5);
      if (m[0] > AX["6"] + 0.6 && m[0] < faces.east - 0.6 && m[1] > AZ["Г"] + 1 && Math.abs(a[1] - b[1]) < 0.3) edge.push([a, b]);
    }
  }
  for (const lvl of [F1, F2]) for (const [a, b] of edge) railing([a, b], lvl);
}

// Стена блока зала в атриуме (выше 1-го этажа), с дверями на галереи
{
  const x = AX["6"] + 0.2;
  const zEnd = plan.diagonal[0][1];
  wallWithHoles(
    [x, AZ["В"]],
    [x, zEnd],
    0.4,
    F1 - SLAB,
    ROOF - SLAB,
    [
      { u0: 1.0, u1: 2.6, y0: F1, y1: F1 + 2.4 },
      { u0: 1.0, u1: 2.6, y0: F2, y1: F2 + 2.4 },
    ],
    "wall",
  );
}

// ── Атриум: косой фасад (лист 12, фасад 1) ──
const D0 = plan.diagonal[0];
const D1 = plan.diagonal[1];
const dDir = unit(sub(D1, D0));
const roundCore = plan.roundCore[0].outer;
{
  // Стена продолжается до круглого объёма
  const reach = rayHit(D0, dDir, roundCore);
  const L = Math.min(Number.isFinite(reach) ? reach + 0.3 : len2(sub(D1, D0)), 30);
  const P1 = add2(D0, mul(dDir, L));
  const top = { y0: 12.07, y1: 14.58 };
  const cols = [
    [1.92, 3.45],
    [3.89, 5.42],
    [5.77, 7.29],
    [7.82, 9.35],
    [9.78, 11.3],
    [11.75, 13.27],
    [13.71, 15.23],
    [15.68, 17.2],
    [17.64, 18.65],
  ];
  // Средний ряд опускается вслед за лестницей
  const midLow = [5.17, 5.17, 5.17, 3.05, 2.42, 2.42, 1.57, 0.72];
  const holes = [
    ...cols.map(([u0, u1]) => ({ u0, u1, ...top })),
    { u0: 0.25, u1: 1.49, y0: 5.17, y1: 9.83 },
    ...cols.slice(0, 8).map(([u0, u1], i) => ({ u0, u1, y0: midLow[i], y1: 9.83 })),
    { u0: 0.25, u1: 1.39, y0: 0.72, y1: 3.47 },
  ];
  // Окна нижнего яруса у входа не пересекаются со средним рядом по высоте — делим колонки
  const fixed = holes.filter((h) => !(h.u0 === 1.92 && h.y0 === 5.17 && h.y1 === 9.83));
  fixed.push({ u0: 1.92, u1: 3.45, y0: 5.17, y1: 9.83 }, { u0: 1.92, u1: 3.45, y0: 0.72, y1: 3.47 });
  // perp(dDir) смотрит на север (внутрь здания): стена лежит к северу от линии витража
  wallWithHoles(D0, P1, 0.35, PLATE, ATRIUM_TOP, fixed, "wall", 0.18);
  // Ламели облицовки (вертикальные линии) снаружи стены
  const n = perp(dDir);
  for (let u = 0.3; u < L; u += 0.45) {
    const q = add2(add2(D0, mul(dDir, u)), mul(n, -0.03));
    const inHole = fixed.some((h) => u > h.u0 - 0.05 && u < h.u1 + 0.05);
    if (inHole) {
      // Ламели только в простенках по высоте
      const hs = fixed.filter((h) => u > h.u0 - 0.05 && u < h.u1 + 0.05).sort((a, b) => a.y0 - b.y0);
      let y = PLATE;
      for (const h of hs) {
        if (h.y0 > y) line([q[0], y, q[1]], [q[0], h.y0, q[1]]);
        y = h.y1;
      }
      line([q[0], y, q[1]], [q[0], ATRIUM_TOP, q[1]]);
    } else line([q[0], PLATE, q[1]], [q[0], ATRIUM_TOP, q[1]]);
  }
}

// ── Атриум: восточный витраж по оси 9 (лист 13, фасад А–3) ──
{
  const E0 = plan.eastGlass[1]; // север
  const E1 = plan.eastGlass[0]; // юг
  const dir = unit(sub(E1, E0));
  const reach = rayHit(E0, dir, roundCore);
  const L = Math.min(Number.isFinite(reach) ? reach + 0.3 : len2(sub(E1, E0)), 12);
  const P1 = add2(E0, mul(dir, L));
  // Колонки окон по z (м от оси З) → u от E0
  const colsZ = [
    [16.26, 17.7],
    [17.95, 19.39],
    [19.64, 21.08],
    [21.33, 22.77],
  ];
  const holes = [];
  for (const [z0, z1] of colsZ) {
    const u0 = z0 - E0[1];
    const u1 = z1 - E0[1];
    if (u1 <= 0.1 || u0 >= L - 0.1) continue;
    const c = { u0: Math.max(0.1, u0), u1: Math.min(L - 0.1, u1) };
    holes.push({ ...c, y0: 0.55, y1: 4.1 }, { ...c, y0: 5.2, y1: 8.58 }, { ...c, y0: 10.98, y1: 12.97 });
  }
  // Стена снаружи по оси 9 (толщина внутрь здания — на запад)
  wallWithHoles(E0, P1, 0.35, PLATE, ATRIUM_TOP, holes, "wall", 0.18);
}

// ── Колонны атриума (розовые, как на видах 2–4) ──
for (const x of [31.0, 36.0, 41.0, 46.0, 51.0]) addSolid("accent", box(x - 0.2, x + 0.2, PLATE, ROOF - SLAB, AZ["В"] - 0.2, AZ["В"] + 0.2));

// ── Парадная лестница атриума (лист 02, разрез 9–3) ──
{
  // Локальные оси: u — вдоль витража на восток, v — от витража на север
  const vN = perp(dDir);
  const at = (u, v) => add2(add2(D0, mul(dDir, u)), mul(vN, v));
  const W = 2.7;
  const vS = 0.6 + W / 2; // южная полоса
  const vNn = 3.6 + W / 2; // северная полоса
  // 0 → +2.692 на запад, площадка, → +4.8 на запад
  flight(at(16.2, vS), at(10.2, vS), W, PLATE, 2.692);
  addSolid("stair", beam(at(10.2, (vS + vNn) / 2), at(8.6, (vS + vNn) / 2), 2 * W + 0.4, 2.45, 2.692));
  flight(at(8.6, vS), at(3.4, vS), W, 2.692, F1);
  // Площадка +4.8 и мостик к галерее
  addSolid("stair", beam(at(3.4, (vS + vNn) / 2), at(1.6, (vS + vNn) / 2), 2 * W + 0.4, F1 - 0.3, F1));
  const bridgeA = at(2.5, vNn + W / 2);
  addSolid("slab", beam(bridgeA, [bridgeA[0], AZ["В"]], 2.2, F1 - 0.3, F1));
  railing([at(1.6, vS - W / 2), at(1.6, vNn + W / 2)], F1);
  // +4.8 → +7.4 на восток (северная полоса), площадка, → +10
  flight(at(3.4, vNn), at(9.0, vNn), W, F1, 7.4);
  addSolid("stair", beam(at(9.0, vNn), at(10.6, vNn), W, 7.1, 7.4));
  flight(at(10.6, vNn), at(15.4, vNn), W, 7.4, F2);
  addSolid("stair", beam(at(15.4, vNn), at(17.2, vNn), W, F2 - 0.3, F2));
  const bridgeB = at(16.3, vNn + W / 2);
  addSolid("slab", beam(bridgeB, [bridgeB[0], AZ["В"]], 2.2, F2 - 0.3, F2));
  // Ограждения маршей
  const railFlight = (u0, u1, v, y0, y1) => {
    for (const side of [-1, 1]) {
      const a = at(u0, v + (side * W) / 2);
      const b = at(u1, v + (side * W) / 2);
      line([a[0], y0 + 1.0, a[1]], [b[0], y1 + 1.0, b[1]]);
      const n = Math.round(Math.abs(u1 - u0) / 0.9);
      for (let k = 0; k <= n; k++) {
        const q = add2(a, mul(sub(b, a), k / n));
        const y = y0 + ((y1 - y0) * k) / n;
        line([q[0], y, q[1]], [q[0], y + 1.0, q[1]]);
      }
    }
  };
  railFlight(16.2, 10.2, vS, PLATE, 2.692);
  railFlight(8.6, 3.4, vS, 2.692, F1);
  railFlight(3.4, 9.0, vNn, F1, 7.4);
  railFlight(10.6, 15.4, vNn, 7.4, F2);
}

// ── Зал ──
const hall = plan.hallFloor[0].outer;
{
  // Сцена
  const stage = [
    [8.29, 20.0],
    [21.65, 20.0],
    [21.65, 24.15],
    [20.38, 24.15],
    [20.38, 24.61],
    [9.92, 24.61],
    [9.92, 24.15],
    [8.29, 24.15],
  ];
  addSolid("stage", prism(ring(stage), PLATE, HALL.stage));
  // Кулисы и падуга
  addSolid("accent", box(8.3, 9.9, HALL.stage, 9.6, 23.9, 24.1), 0);
  addSolid("accent", box(20.4, 21.65, HALL.stage, 9.6, 23.9, 24.1), 0);
  addSolid("accent", box(8.3, 21.65, 8.6, 9.6, 23.9, 24.1));
  addSolid("accent", box(8.6, 21.4, HALL.stage + 1.2, 9.2, 20.6, 20.75), 0);

  // Амфитеатр: ярусы под рядами кресел
  const seats = plan.seats;
  const rows = [...seats.rows].sort((a, b) => a.z - b.z);
  const tier = (k) => PLATE + Math.max(0, k - 1) * 0.15;
  rows.forEach((r, k) => {
    const z0 = k === 0 ? r.z - 0.9 : (rows[k - 1].z + r.z) / 2;
    const z1 = k === rows.length - 1 ? 60 : (r.z + rows[k + 1].z) / 2;
    const h = tier(k);
    if (h > PLATE + 0.01) {
      const band = clipBand(hall, z0, z1);
      if (band.length >= 3) addSolid("stage", prism(ring(band), PLATE, h));
    }
    for (const x of r.x) {
      if (!pointInPoly([x, r.z + 0.3], hall)) continue;
      const w = seats.pitch * 0.82;
      addSolid("seat", box(x - w / 2, x + w / 2, h, h + 0.45, r.z - 0.22, r.z + 0.2), 0);
      addSolid("seat", box(x - w / 2, x + w / 2, h + 0.2, h + 0.95, r.z + 0.2, r.z + 0.3), 0);
    }
  });

  // Балкон вдоль полукруглой задней стены
  const zb = 38.2;
  const bal = clipHalf(hall, 0, -1, -zb);
  if (bal.length >= 3) {
    addSolid("slab", prism(ring(bal), HALL.balcony - 0.3, HALL.balcony));
    const xs = bal.filter((p) => Math.abs(p[1] - zb) < 1e-6).map((p) => p[0]);
    const bx0 = Math.min(...xs);
    const bx1 = Math.max(...xs);
    addSolid("accent", box(bx0, bx1, HALL.balcony, HALL.balcony + 1.0, zb - 0.05, zb + 0.05));
    for (const [dz, dy] of [
      [0.9, 0.0],
      [1.9, 0.35],
    ]) {
      const z = zb + dz;
      const row = clipBand(hall, z - 0.3, z + 0.3);
      if (row.length < 3) continue;
      const rx0 = Math.min(...row.map((p) => p[0])) + 0.6;
      const rx1 = Math.max(...row.map((p) => p[0])) - 0.6;
      const y = HALL.balcony + dy;
      if (dy) addSolid("slab", prism(ring(clipBand(hall, z - 0.5, 60)), HALL.balcony, y));
      for (let x = rx0; x <= rx1; x += seats.pitch) {
        addSolid("seat", box(x - 0.24, x + 0.24, y, y + 0.45, z - 0.22, z + 0.2), 0);
        addSolid("seat", box(x - 0.24, x + 0.24, y + 0.2, y + 0.95, z + 0.2, z + 0.3), 0);
      }
    }
  }

  // Технические галереи вдоль боковых стен
  const xL = Math.min(...hall.map((p) => p[0]));
  const xR = Math.max(...hall.map((p) => p[0]));
  for (const [a, b] of [
    [xL, xL + 1.1],
    [xR - 1.1, xR],
  ]) {
    addSolid("slab", box(a, b, HALL.gallery - 0.2, HALL.gallery, 21.0, 36.5));
    const xe = a === xL ? b : a;
    railing([[xe, 21.0], [xe, 36.5]], HALL.gallery, 1.0, false);
  }
  // Мостик над сценой
  addSolid("slab", box(xL, xR, HALL.gallery - 0.2, HALL.gallery, 22.3, 23.3));
  railing([[xL, 22.3], [xR, 22.3]], HALL.gallery, 1.0, false);
  railing([[xL, 23.3], [xR, 23.3]], HALL.gallery, 1.0, false);

  // Фермы покрытия (разрез 9–3): пояса, стойки и раскосы
  for (const z of [21.2, 24.6, 28.0, 31.4, 34.8, 38.2]) {
    const span = clipBand(hall, z - 0.01, z + 0.01);
    if (span.length < 2) continue;
    const x0 = Math.min(...span.map((p) => p[0]));
    const x1 = Math.max(...span.map((p) => p[0]));
    const t = 0.22;
    addSolid("metal", box(x0, x1, HALL.truss0, HALL.truss0 + t, z - t / 2, z + t / 2), 0);
    addSolid("metal", box(x0, x1, HALL.truss1 - t, HALL.truss1, z - t / 2, z + t / 2), 0);
    const panels = Math.max(2, Math.round((x1 - x0) / 2.6));
    for (let k = 0; k <= panels; k++) {
      const x = x0 + ((x1 - x0) * k) / panels;
      addSolid("metal", rod([x, HALL.truss0, z], [x, HALL.truss1, z], 0.06, 4), 0);
      if (k < panels) {
        const xn = x0 + ((x1 - x0) * (k + 1)) / panels;
        const up = k % 2 === 0;
        addSolid("metal", rod([x, up ? HALL.truss0 : HALL.truss1, z], [xn, up ? HALL.truss1 : HALL.truss0, z], 0.05, 4), 0);
      }
    }
  }
}

// Перекрытия блока зала над боковыми помещениями — уже в slabMid; плиты над залом нет до кровли

// ── Плавники зала ──
// (кроме тех, что попали на линию косого фасада за углом зала)
for (const f of plan.hallFins) {
  const w = sub(f.p, plan.diagonal[0]);
  const dd = unit(sub(plan.diagonal[1], plan.diagonal[0]));
  const along = w[0] * dd[0] + w[1] * dd[1];
  const off = Math.abs(w[0] * dd[1] - w[1] * dd[0]);
  if (along > 0.3 && off < 1.2) continue;
  fin(f.p, f.n, FIN_FROM, PARAPET);
}

// ── Круглый объём на V-опорах ──
{
  const core = plan.roundCore;
  addSolid("dark", prism(plan.roundRing, ROUND.soffit, ROUND.top));
  addSolid("slab", prism(core, ROUND.soffit, ROUND.floor));
  addSolid("slab", prism(core, F2 - SLAB, F2));
  addSolid("slab", prism(core, ROUND.roof - SLAB, ROUND.roof));

  // Южная грань: объём повёрнут вдоль косого фасада — берём точки контура,
  // лежащие дальше всего на юг в этих осях
  const nS = mul(perp(dDir), -1);
  const proj = roundCore.map((p) => ({ p, s: p[0] * nS[0] + p[1] * nS[1], u: p[0] * dDir[0] + p[1] * dDir[1] }));
  const sMax = Math.max(...proj.map((q) => q.s));
  const edge = proj.filter((q) => q.s > sMax - 0.35);
  const u0 = Math.min(...edge.map((q) => q.u));
  const u1 = Math.max(...edge.map((q) => q.u));
  const at = (u) => add2(mul(dDir, u), mul(nS, sMax));
  const a = at(u0);
  const L = u1 - u0;
  // x-диапазоны окон с фасада 1 → u вдоль грани (фасад смотрит под 14° к оси)
  const u = (x) => Math.min(L, Math.max(0, (x - a[0]) / dDir[0]));
  const ribbon = { u0: u(49.0), u1: u(59.9), y0: 10.0, y1: 14.6 };
  const square = { u0: u(49.0), u1: u(51.4), y0: 6.2, y1: 8.8 };

  // Плавники по всему контуру; на южной грани — в обход окон (перспектива, лист 14)
  for (const f of plan.roundFins) {
    const onFace = f.n[0] * nS[0] + f.n[1] * nS[1] > 0.8;
    const fu = f.p[0] * dDir[0] + f.p[1] * dDir[1] - u0;
    const gaps = onFace ? [ribbon, square].filter((w) => fu > w.u0 - 0.7 && fu < w.u1 + 0.7) : [];
    let y = ROUND.soffit;
    for (const w of gaps.sort((p, q) => p.y0 - q.y0)) {
      if (w.y0 - 0.35 > y) fin(f.p, f.n, y, w.y0 - 0.35);
      y = w.y1 + 0.35;
    }
    if (ROUND.top > y) fin(f.p, f.n, y, ROUND.top);
  }

  // Окна в розовых рамах-«коробах», выступающих за плавники
  const framed = (w, depth) => {
    const A = at(u0 + w.u0 - 0.3);
    const B = at(u0 + w.u1 + 0.3);
    const o = 0.1 + depth / 2;
    addSolid("accent", beam(A, B, depth, w.y1, w.y1 + 0.3, -o));
    addSolid("accent", beam(A, B, depth, w.y0 - 0.3, w.y0, -o));
    for (const uu of [w.u0 - 0.15, w.u1 + 0.15]) {
      const P = at(u0 + uu - 0.15);
      const Q = at(u0 + uu + 0.15);
      addSolid("accent", beam(P, Q, depth, w.y0 - 0.3, w.y1 + 0.3, -o));
    }
  };
  surfaceWindow(a, dDir, nS, ribbon.u0, ribbon.u1, ribbon.y0, ribbon.y1, { proud: 0.05, mullions: 6 });
  framed(ribbon, 1.0);
  // Ограждение лоджии
  const r0 = add2(at(u0 + ribbon.u0), mul(nS, 0.6));
  const r1 = add2(at(u0 + ribbon.u1), mul(nS, 0.6));
  addSolid("metal", beam(r0, r1, 0.08, 10.0, 11.1), 0);
  for (let k = 0; k <= 60; k++) {
    const q = add2(r0, mul(sub(r1, r0), k / 60));
    line([q[0], 10.0, q[1]], [q[0], 11.1, q[1]]);
  }
  surfaceWindow(a, dDir, nS, square.u0, square.u1, square.y0, square.y1, { proud: 0.05, mullions: 0 });
  framed(square, 0.7);

  // V-опоры
  for (const { p, t } of plan.legs) {
    for (const side of [-1, 1]) {
      const top = add2(p, mul(t, 1.5 * side));
      addSolid("dark", rod([p[0], 0, p[1]], [top[0], ROUND.soffit, top[1]], 0.24, 8), 0);
    }
  }

  // Стеклянный тамбур 28 под объёмом
  const r28 = plan.room28;
  for (let i = 0; i < r28.length; i++) {
    const a = r28[i];
    const b = r28[(i + 1) % r28.length];
    addSolid("glass", beam(a, b, 0.05, PLATE, ROUND.soffit), 0);
    const L = len2(sub(b, a));
    const n = Math.max(1, Math.round(L / 1.4));
    for (let k = 0; k <= n; k++) {
      const q = add2(a, mul(sub(b, a), k / n));
      addSolid("frame", box(q[0] - 0.05, q[0] + 0.05, PLATE, ROUND.soffit, q[1] - 0.05, q[1] + 0.05), 0);
    }
    addSolid("frame", beam(a, b, 0.12, 2.6, 2.7), 0);
  }
}

// ── Кровля ──
addSolid("slab", prism(plan.roofLow, ROOF - SLAB, ROOF));
addSolid("slab", prism(plan.roofHigh, ROOF - SLAB, ROOF_HIGH));
{
  // Ограждение по краю основной кровли (аксонометрии, взрыв-схема) — кроме атриума
  const edge = plan.plate[0].outer;
  const pts = [];
  const flush = () => {
    if (pts.length > 1) railing(pts, PARAPET, 1.0, false);
    pts.length = 0;
  };
  for (let i = 0; i <= edge.length; i++) {
    const p = edge[i % edge.length];
    const inner = add2(p, [0, 0]);
    const skip = (p[0] > AX["6"] + 0.5 && p[1] > AZ["Г"] + 0.5) || pointInPoly(p, roundCore);
    if (skip) flush();
    else pts.push(inner);
  }
  flush();
}
for (const [x0, z0, x1, z1] of plan.skylights) {
  const ROOF = ROOF_HIGH;
  addSolid("glass", box(x0, x1, ROOF, ROOF + 0.55, z0, z1), 0);
  for (const [a, b] of [
    [[x0, z0], [x1, z0]],
    [[x1, z0], [x1, z1]],
    [[x1, z1], [x0, z1]],
    [[x0, z1], [x0, z0]],
  ])
    addSolid("frame", beam(a, b, 0.1, ROOF + 0.5, ROOF + 0.58), 0);
  addSolid("frame", box((x0 + x1) / 2 - 0.04, (x0 + x1) / 2 + 0.04, ROOF, ROOF + 0.58, z0, z1), 0);
}
// Техоборудование на кровле (фасад 2, взрыв-схема)
for (const [x0, x1, z0, z1, top] of [
  [54.0, 56.0, 2.2, 5.0, 18.9],
  [49.9, 52.9, 2.5, 4.5, 18.9],
  [40.0, 49.8, 6.0, 9.0, 19.2],
  [30.0, 33.3, 3.0, 6.0, 19.21],
  [28.0, 29.9, 9.0, 11.0, 19.0],
  [16.4, 27.7, 4.0, 7.5, 20.11],
  [8.6, 18.5, 10.8, 13.4, 18.9],
  [2.7, 5.8, 2.0, 4.0, 19.0],
  // три кубика рядом (аксонометрии листа 11)
  [34.5, 36.3, 10.5, 12.3, 18.8],
  [36.6, 38.4, 10.5, 12.3, 18.8],
  [38.7, 40.5, 10.5, 12.3, 18.8],
  [0.6, 2.4, 9.0, 12.0, 20.41],
]) {
  addSolid("roofbox", box(x0, x1, ROOF, top, z0, z1));
  // Решётки вентиляции
  for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.4) line([x, ROOF + 0.4, z0 - 0.01], [x, top - 0.3, z0 - 0.01]);
}

// ── Северный фасад (лист 13, фасад 2): окна 2-го и 3-го этажей, панели ──
{
  const z = faces.north;
  const p0 = [faces.west, z];
  const d = [1, 0];
  const n = [0, -1];
  // Панели выступают на 0.16 м — окна в их пределах выносим вперёд
  const inPanel = (x) => (x > 8.75 && x < 21.0) || (x > 39.3 && x < 51.6);
  const win = (x0, x1, y0, y1) =>
    surfaceWindow(p0, d, n, x0 - p0[0], x1 - p0[0], y0, y1, { proud: inPanel((x0 + x1) / 2) ? 0.2 : 0.06 });
  for (const [x0, x1] of [
    [47.48, 49.18],
    [41.23, 42.92],
    [24.19, 25.67],
    [18.31, 19.66],
    [15.86, 17.21],
  ])
    win(x0, x1, 11.57, 13.98);
  win(35.31, 36.79, 11.57, 13.56);
  for (const [x0, x1] of [
    [45.54, 47.15],
    [35.1, 36.79],
    [27.48, 29.18],
    [21.48, 23.17],
  ])
    win(x0, x1, 6.57, 8.94);
  for (const [x0, x1] of [
    [49.01, 50.23],
    [40.72, 41.95],
    [31.8, 32.98],
    [24.19, 25.37],
    [7.06, 8.33],
    [3.72, 4.99],
  ])
    win(x0, x1, 6.57, 8.52);
  win(15.86, 17.08, 5.85, 7.8);

  // Панели с горизонтальной полосой (серые) и вертикальные ламели на остальном
  const zp = z - 0.08;
  for (const [x0, x1] of [
    [8.75, 21.0],
    [39.3, 51.6],
  ]) {
    addSolid("panel", box(x0, x1, F1 + 0.1, PARAPET, zp - 0.08, zp + 0.08));
    for (let y = F1 + 0.6; y < PARAPET; y += 0.55) line([x0, y, zp - 0.1], [x1, y, zp - 0.1]);
  }
  for (let x = faces.west + 0.25; x < faces.east; x += 0.42) {
    if (inPanel(x)) continue;
    line([x, PLATE, z - 0.03], [x, PARAPET, z - 0.03]);
  }
  // Пояса по этажам
  line([faces.west, F1 + 0.2, z - 0.05], [faces.east, F1 + 0.2, z - 0.05]);
  line([faces.west, F2, z - 0.05], [faces.east, F2, z - 0.05]);
}

// ── Восточный фасад северного блока ──
{
  const x = faces.east;
  const p0 = [x, 0];
  const d = [0, 1];
  const n = [1, 0];
  surfaceWindow(p0, d, n, 13.18, 15.16, 6.34, 8.24);
  surfaceWindow(p0, d, n, 13.18, 15.16, 10.98, 12.97);
  for (let z = 0.4; z < 16.4; z += 0.42) line([x + 0.03, PLATE, z], [x + 0.03, PARAPET, z]);
}

// ── Западный фасад: двери на площадки пожарной лестницы ──
{
  const x = faces.westNotch;
  for (const y of [F1 + 0.2, F2]) surfaceWindow([x, 0], [0, 1], [-1, 0], 17.2, 18.7, y, y + 2.35, { mullions: 0 });
  for (let z = 0.4; z < 19.4; z += 0.42) {
    const xx = z < 7.4 ? faces.west : x;
    line([xx - 0.03, PLATE, z], [xx - 0.03, PARAPET, z]);
  }
}

// ── Наружная пожарная лестница (лист 13, фасад 3–А) ──
{
  const xOut = [-1.4, 0.45];
  const xIn = [0.55, 2.45];
  const north = [7.2, 9.5];
  const south = [14.1, 19.2];
  const levels = [PLATE, 2.5, F1 + 0.2, 7.5, F2, 12.35, 14.7, ROOF];
  const W = 1.8;
  for (let i = 0; i + 1 < levels.length; i++) {
    const y0 = levels[i];
    const y1 = levels[i + 1];
    const toNorth = i % 2 === 0;
    const lane = toNorth ? xOut : xIn;
    const xc = (lane[0] + lane[1]) / 2;
    const a = [xc, toNorth ? south[0] : north[1]];
    const b = [xc, toNorth ? north[1] : south[0]];
    flight(a, b, W, y0, y1, "metal");
    // Площадка в конце марша
    const [za, zb] = toNorth ? north : south;
    addSolid("metal", box(-1.4, 2.45, y1 - 0.15, y1, za, zb));
    const edge = toNorth
      ? [
          [2.45, za],
          [-1.4, za],
          [-1.4, zb],
        ]
      : [
          [-1.4, za],
          [-1.4, zb],
          [2.45, zb],
        ];
    railing(edge, y1, 1.1, false);
    // Перила марша с внешней стороны
    const side = toNorth ? -W / 2 : W / 2;
    line([xc + side, y0 + 1.0, a[1]], [xc + side, y1 + 1.0, b[1]]);
  }
  // Стойки каркаса
  for (const [x, z] of [
    [-1.35, 7.25],
    [-1.35, 9.45],
    [-1.35, 14.15],
    [-1.35, 19.15],
  ])
    addSolid("metal", box(x - 0.08, x + 0.08, 0, ROOF + 1.1, z - 0.08, z + 0.08), 0);
}

// ═══════════════════ Запись ═══════════════════

const { k, theta, ox, oz } = plan.transform;
const M = new THREE.Matrix4()
  .makeTranslation(ox, 0, oz)
  .multiply(new THREE.Matrix4().makeRotationY(-theta))
  .multiply(new THREE.Matrix4().makeScale(k, k, k));

const meshes = [];
let triangles = 0;
for (const [mat, list] of solids) {
  const merged = mergeGeometries(list);
  list.forEach((g) => g.dispose());
  merged.applyMatrix4(M);
  const indexed = mergeVertices(merged, 1e-7);
  triangles += indexed.index.count / 3;
  meshes.push({ name: mat, mode: 4, geo: indexed });
}
for (const [name, arr] of [
  ["edges", edgePos],
  ["lines", linePos],
]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  g.applyMatrix4(M);
  meshes.push({ name, mode: 1, geo: mergeVertices(g, 1e-7) });
}

/** Минимальный GLB: позиции и индексы, по мешу на материал. */
const writeGLB = (items) => {
  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const push = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.byteLength + pad;
    return bufferViews.length - 1;
  };
  const gltf = {
    asset: { version: "2.0", generator: "make-school-model" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors,
    bufferViews,
    buffers: [],
  };
  for (const { name, mode, geo } of items) {
    const pos = geo.attributes.position.array;
    const box3 = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
    const pv = push(new Float32Array(pos), 34962);
    accessors.push({
      bufferView: pv,
      componentType: 5126,
      count: pos.length / 3,
      type: "VEC3",
      min: box3.min.toArray(),
      max: box3.max.toArray(),
    });
    const posAcc = accessors.length - 1;
    const idx = geo.index.array;
    const big = pos.length / 3 > 65535;
    const iv = push(big ? new Uint32Array(idx) : new Uint16Array(idx), 34963);
    accessors.push({ bufferView: iv, componentType: big ? 5125 : 5123, count: idx.length, type: "SCALAR" });
    gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } });
    gltf.meshes.push({
      name,
      primitives: [{ attributes: { POSITION: posAcc }, indices: accessors.length - 1, mode, material: gltf.materials.length - 1 }],
    });
    gltf.nodes.push({ name, mesh: gltf.meshes.length - 1 });
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }
  gltf.buffers.push({ byteLength: offset });
  const bin = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, json, bh, bin]);
};

const glb = writeGLB(meshes);
writeFileSync(new URL("model.glb", OUT_DIR), glb);

// Метаданные для ProjectModel: высота, контур кровли (вписывание камеры),
// контуры стен 1-го этажа (светящийся срез при «печати»)
const toCard = ([x, z]) => {
  const v = new THREE.Vector3(x, 0, z).applyMatrix4(M);
  return [+v.x.toFixed(5), +v.z.toFixed(5)];
};
const rings = (polys) => polys.flatMap((p) => [p.outer, ...(p.holes ?? [])]).map((r) => r.map(toCard));
const all = new THREE.Box3();
for (const { geo } of meshes) {
  geo.computeBoundingBox();
  all.union(geo.boundingBox);
}
const meta = {
  format: 2,
  model: "model.glb",
  height: +all.max.y.toFixed(5),
  bounds: [
    [+all.min.x.toFixed(5), +all.min.z.toFixed(5)],
    [+all.max.x.toFixed(5), +all.max.z.toFixed(5)],
  ],
  outline: rings(plan.plate).slice(0, 1),
  scan: rings([...plan.wallsOuter, ...plan.wallsInner, ...plan.wallsHall]),
  buildMs: 3800,
};
writeFileSync(new URL("model.json", OUT_DIR), JSON.stringify(meta));

const kb = (n) => `${Math.round(n / 1024)} КБ`;
console.log(
  `school: ${meshes.length} мешей, ${Math.round(triangles / 1000)} тыс. треугольников, ` +
    `${Math.round(edgePos.length / 6000)} тыс. рёбер, ${Math.round(linePos.length / 6000)} тыс. линий, ` +
    `model.glb ${kb(glb.length)}, высота ${meta.height}`,
);
