"""
3D-макет музыкальной школы из экспорта Revit (IFC) → public/projects/school/model.glb (+ model.json).

Замена ручной сборки (make-school-model.mjs): геометрия берётся из IFC как есть.
  1. ifcopenshell триангулирует все элементы (мировые координаты, мм → м).
  2. Каждый элемент попадает в «корзину» материала по классу IFC и цвету стиля —
     имена корзин те же, что понимает ProjectModel (wall, slab, glass, frame…).
  3. Мелкая геометрия (ручки дверей, балясины) упрощается кластеризацией вершин
     по сетке GRID — на карточке детали мельче пары сантиметров не видны.
  4. Совмещение с карточкой: сдвиг IFC → метры плана (оси 1/З) подбирается
     корреляцией стен 1-го этажа с scripts/data/school-plan.json, дальше —
     его transform (план → координаты карточки).
  5. Рёбра — по двугранному углу; контуры «печати» и кровли — по срезам.
  6. plate.png (верх карточки после «укладки») — иконка без линий плана 2-го этажа
     и с планом 1-го этажа по срезу стен IFC: иначе под поднятым круглым объёмом
     на земле видны стены, которых там нет.
  7. Облицовка «Стены ступенчатая» — отдельная стена поверх наружной, проёмы окон
     Revit вырезал только в наружной, и облицовка закрывала окна. Прорезаем её
     проёмами (IfcOpeningElement), к которым она прилегает; откосы — крышки по срезу.
  8. GLB сжимается gltfpack (meshopt + квантование; ProjectModel подключает MeshoptDecoder).

Запуск: python scripts/make-school-ifc.py [путь к .ifc]   (нужны ifcopenshell, numpy, opencv-python-headless)
Путь по умолчанию — SCHOOL_IFC или файл проекта Revit ниже. Контроль — .model-debug/school-ifc.png.
"""

import json
import math
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "projects" / "school"
DEBUG_DIR = ROOT / ".model-debug"
PLAN = ROOT / "scripts" / "data" / "school-plan.json"
DEFAULT_IFC = Path(
    os.environ.get(
        "SCHOOL_IFC",
        r"C:\Users\cr7um_geelv3s\Desktop\Revit\Projects\Проект Школы (Art Brodsky)\Проект Школы (Art Brodsky).ifc",
    )
)

# Сетка упрощения (склейка близких вершин), м; для мелких изделий — крупнее.
# Треугольники дёшевы (кадр от них почти не зависит) — упрощаем в меру, только
# чтобы убрать то, что мельче пикселя на экране.
GRID = 0.01
GRID_SMALL = {"IfcDoor": 0.03, "IfcWindow": 0.025, "IfcRailing": 0.03}
# У тех же изделий отбрасываются куски меньше этой диагонали (ручки, петли, крепёж), м
MIN_PIECE = 0.12
# Доля треугольников после упрощения в gltfpack (1 — без упрощения)
SIMPLIFY = 1.0
# Порог двугранного угла для рёбер, град.
EDGE_ANGLE = 30
# Корзины с рёбрами (у стекла, переплётов и дверей рёбер слишком много — шум)
EDGE_MATS = {"wall", "panel", "slab", "floor", "stair", "wood", "dark"}
# Высота среза для «печати» и совмещения, м от пола 1-го этажа
SCAN_Y = 1.2
SKIP = {"IfcOpeningElement", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcSite", "IfcBuilding", "IfcBuildingStorey"}
# Облицовка — отдельная стена поверх наружной; Revit вырезает проёмы окон только в
# стене-хозяине, и облицовка закрывала окна. Прорезаем её проёмами соседних стен.
CUT_BY_OPENINGS = ("Стены ступенчатая",)
# Насколько проём продлевается сквозь облицовку (она толщиной до 1.2 м), м
OPENING_DEPTH = 2.0
# Окна, которых нет в модели: три рамки верхнего ряда левого ступенчатого блока в Revit
# без окон и проёмов (за облицовкой глухая стена). Ставим туда копии окон нижнего ряда
# (Revit id → сдвиг вверх, м) и прорезаем под них наружную стену и облицовку.
ADD_WINDOWS = {"458076": 4.2, "458010": 4.2, "432641": 4.2}
WALLS = ("IfcWall", "IfcWallStandardCase")


def is_glass(rgb, transparency):
    r, g, b = rgb
    return transparency > 0.2 or (b > r + 0.12 and b > 0.45)


def bucket(cls, rgb, transparency):
    """Имя материала ProjectModel для элемента класса cls с цветом стиля rgb."""
    lum = sum(rgb) / 3
    warm = rgb[0] > rgb[2] + 0.15
    if cls in ("IfcWindow", "IfcDoor"):
        if is_glass(rgb, transparency):
            return "glass"
        if warm:
            return "wood"
        return "frame" if lum > 0.55 else "metal"
    if cls == "IfcPlate":
        return "glass" if is_glass(rgb, transparency) else "panel"
    if cls == "IfcMember":
        return "glass" if transparency > 0.2 else ("frame" if lum > 0.55 else "metal")
    if cls in ("IfcWall", "IfcWallStandardCase"):
        return "wall" if lum > 0.9 else "panel"
    if cls in ("IfcSlab", "IfcRoof"):
        return "slab" if lum > 0.55 else "dark"
    if cls == "IfcCovering":
        return "floor"
    if cls in ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"):
        return "stair"
    if cls == "IfcRailing":
        return "rail"
    if cls in ("IfcBeam", "IfcColumn"):
        return "wood" if warm else "wall"
    if cls == "IfcFurnishingElement":
        return "seat" if rgb[0] > rgb[1] + 0.2 else "furn"
    return "wall"


def tessellate(path):
    import ifcopenshell
    import ifcopenshell.geom

    f = ifcopenshell.open(str(path))
    unit = 1.0
    for u in f.by_type("IfcSIUnit"):
        if u.UnitType == "LENGTHUNIT" and u.Prefix == "MILLI":
            unit = 0.001  # геометрию ifcopenshell отдаёт в метрах, отметки этажей — в единицах файла
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    it = ifcopenshell.geom.iterator(settings, f, os.cpu_count() or 4)
    parts = []  # (класс, материал, вершины N×3, треугольники M×3)
    openings = []  # вершины проёмов (IfcOpeningElement)
    cladding = []  # (класс, вершины, треугольники, номера материалов, материалы) — облицовка без проёмов
    walls = []  # остальные стены — в них прорезаются проёмы добавленных окон (ADD_WINDOWS)
    added = []  # вершины проёмов добавленных окон
    if not it.initialize():
        raise SystemExit("IFC: нет геометрии")
    while True:
        shape = it.get()
        el = f.by_id(shape.id)
        cls = el.is_a()
        g = shape.geometry
        if cls == "IfcOpeningElement":
            ov = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
            openings.append(ov)
            for r in el.HasFillings:
                dz = ADD_WINDOWS.get(r.RelatedBuildingElement.Tag)
                if dz:
                    added.append(ov + [0.0, 0.0, dz])
        if cls not in SKIP:
            v = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
            tri = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
            mids = np.asarray(g.material_ids, dtype=np.int64)
            if cls == "IfcWindow" and el.Tag in ADD_WINDOWS:
                parts += split_materials(cls, v + [0.0, 0.0, ADD_WINDOWS[el.Tag]], tri, mids, g.materials)
            if any(s in (el.Name or "") for s in CUT_BY_OPENINGS):
                cladding.append((cls, v, tri, mids, g.materials))
            elif cls in WALLS:
                walls.append((cls, v, tri, mids, g.materials))
            else:
                parts += split_materials(cls, v, tri, mids, g.materials)
        if not it.next():
            break
    for cls, v, tri, mids, mats in walls:
        for ov in added:
            frame, lo, hi = opening_frame(ov)
            v, tri, mids = cut_box(v, tri, mids, frame, lo - [0, 0.005, 0], hi + [0, 0.005, 0])
        parts += split_materials(cls, v, tri, mids, mats)
    for cls, v, tri, mids, mats in cladding:
        for ov in openings + added:
            v, tri, mids = cut_opening(v, tri, mids, ov)
        parts += split_materials(cls, v, tri, mids, mats)
    levels = sorted(s.Elevation * unit for s in f.by_type("IfcBuildingStorey") if s.Elevation is not None)
    return parts, levels


def split_materials(cls, v, tri, mids, materials):
    out = []
    for mi, m in enumerate(materials):
        sel = tri[mids == mi]
        if not len(sel):
            continue
        rgb = tuple(m.diffuse.components) if m.diffuse else (0.8, 0.8, 0.8)
        transp = m.transparency if m.transparency == m.transparency else 0.0
        out.append((cls, bucket(cls, rgb, transp or 0.0), v, sel))
    return out


def _split(poly, k, b):
    """Многоугольник (m×3) плоскостью coord[k] = b → (часть ниже, часть выше)."""
    lo, hi = [], []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        dp, dq = p[k] - b, q[k] - b
        (lo if dp < 0 else hi).append(p)
        if (dp < 0) != (dq < 0):
            x = p + (q - p) * (dp / (dp - dq))
            lo.append(x)
            hi.append(x)
    return np.array(lo), np.array(hi)


def cut_box(v, tri, mids, frame, lo, hi):
    """Вычитает из замкнутой сетки коробку [lo, hi] в осях frame = (начало, строки осей).
    Треугольники, задевающие коробку, режутся её гранями; на боковых гранях (по осям 0 и 2) —
    крышки по срезу сетки, чтобы у проёма были откосы, а не пустая изнанка."""
    import shapely

    c, A = frame
    tl = (v - c) @ A.T
    tl = tl[tri]
    touch = np.all((tl.max(1) > lo) & (tl.min(1) < hi), axis=1)
    if not touch.any():
        return v, tri, mids
    # Плоскости граней коробки режут все треугольники, которые пересекают, а не только
    # задевающие коробку: иначе у соседа остаётся целое ребро против разрезанного
    # (Т-стык), feature_edges считает оба открытыми, и по стене тянется лишняя линия.
    planes = [(k, x) for k in range(3) for x in (lo[k], hi[k])]
    split = np.zeros(len(tri), bool)
    for k, x in planes:
        split |= (tl[:, :, k].min(1) < x) & (tl[:, :, k].max(1) > x)
    split |= touch
    polys, pm = list(tl[split]), list(mids[split])
    for k, x in planes:
        nxt, nm = [], []
        for p, m in zip(polys, pm):
            if p[:, k].min() < x < p[:, k].max():
                for q in _split(p, k, x):
                    if len(q) >= 3:
                        nxt.append(q)
                        nm.append(m)
            else:
                nxt.append(p)
                nm.append(m)
        polys, pm = nxt, nm
    out = [not np.all((p.mean(0) > lo) & (p.mean(0) < hi)) for p in polys]
    polys = [p for p, o in zip(polys, out) if o]
    pm = [m for m, o in zip(pm, out) if o]
    new = [p[[0, i, i + 1]] for p in polys for i in range(1, len(p) - 1)]
    new_m = [m for p, m in zip(polys, pm) for _ in range(len(p) - 2)]
    cap_m = np.bincount(mids[touch]).argmax()
    for k in (0, 2):
        a1, a2 = [j for j in range(3) if j != k]
        rect = shapely.box(lo[a1], lo[a2], hi[a1], hi[a2])
        for b, sgn in ((lo[k], 1.0), (hi[k], -1.0)):
            d = tl[:, :, k] - b
            cross = (d.min(1) < 0) & (d.max(1) > 0)
            segs = []
            for t, dd in zip(tl[cross], d[cross]):
                pts = []
                for i in range(3):
                    p, q, dp, dq = t[i], t[(i + 1) % 3], dd[i], dd[(i + 1) % 3]
                    if (dp < 0) != (dq < 0):
                        x = p + (q - p) * (dp / (dp - dq))
                        pts.append((round(x[a1], 6), round(x[a2], 6)))
                if len(pts) == 2 and pts[0] != pts[1]:
                    segs.append(pts)
            if not segs:
                continue
            area = shapely.build_area(shapely.union_all(shapely.linestrings(segs))).intersection(rect)
            if area.is_empty or area.area < 1e-6:
                continue
            for tr in shapely.get_parts(shapely.constrained_delaunay_triangles(area)):
                xy = np.array(tr.exterior.coords)[:3]
                P = np.zeros((3, 3))
                P[:, k], P[:, a1], P[:, a2] = b, xy[:, 0], xy[:, 1]
                if np.cross(P[1] - P[0], P[2] - P[0])[k] * sgn < 0:  # нормаль — внутрь проёма
                    P = P[::-1]
                new.append(P)
                new_m.append(cap_m)
    keep, keep_m = tri[~split], mids[~split]
    if new:
        nt = np.array(new) @ A + c
        keep = np.concatenate([keep, len(v) + np.arange(len(nt) * 3).reshape(-1, 3)])
        keep_m = np.concatenate([keep_m, np.array(new_m, dtype=mids.dtype)])
        v = np.concatenate([v, nt.reshape(-1, 3)])
    return v, keep, keep_m


def opening_frame(ov):
    """Оси проёма (вдоль стены, поперёк, вверх) и его габарит в них."""
    xy = ov[:, :2]
    m = xy.mean(0)
    _, _, vt = np.linalg.svd(xy - m, full_matrices=False)
    A = np.array([[*vt[0], 0.0], [*vt[1], 0.0], [0.0, 0.0, 1.0]])
    c = np.array([*m, 0.0])
    L = (ov - c) @ A.T
    return (c, A), L.min(0), L.max(0)


def cut_opening(v, tri, mids, ov):
    """Прорезает облицовку проёмом стены-хозяина (вершины ov): если облицовка прилегает
    к проёму с одной стороны, коробка проёма продлевается сквозь неё на OPENING_DEPTH."""
    (c, A), lo, hi = opening_frame(ov)
    tl = ((v - c) @ A.T)[tri]
    for side in (1, -1):
        # Прилегает ли облицовка к грани проёма (тонкий слой у неё)
        a, b = (hi[1] - 0.01, hi[1] + 0.05) if side > 0 else (lo[1] - 0.05, lo[1] + 0.01)
        near = (tl.max(1) > [lo[0], a, lo[2]]) & (tl.min(1) < [hi[0], b, hi[2]])
        if not near.all(1).any():
            continue
        l2, h2 = lo.copy(), hi.copy()
        if side > 0:
            h2[1] = hi[1] + OPENING_DEPTH
        else:
            l2[1] = lo[1] - OPENING_DEPTH
        v, tri, mids = cut_box(v, tri, mids, (c, A), l2, h2)
        tl = ((v - c) @ A.T)[tri]
    return v, tri, mids


def simplify(v, tri, grid):
    """Кластеризация вершин по сетке + удаление вырожденных и повторных треугольников."""
    q = np.round(v / grid).astype(np.int64)
    keys, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    # Представитель кластера — среднее его вершин
    sums = np.zeros((len(keys), 3))
    np.add.at(sums, inv, v)
    cnt = np.bincount(inv, minlength=len(keys))[:, None]
    nv = sums / cnt
    t = inv[tri]
    ok = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
    t = t[ok]
    # Одинаковые треугольники (в любом порядке обхода) — оставляем один
    _, first = np.unique(np.sort(t, axis=1), axis=0, return_index=True)
    t = t[np.sort(first)]
    used, t = np.unique(t, return_inverse=True)
    return nv[used], t.reshape(-1, 3)


def drop_small_pieces(v, tri, min_size):
    """Убирает связные куски сетки с диагональю габарита меньше min_size."""
    # Сварка совпадающих вершин (до 1 мм), затем распространение меток по треугольникам
    _, weld = np.unique(np.round(v / 0.001).astype(np.int64), axis=0, return_inverse=True)
    t = weld.reshape(-1)[tri]
    label = np.arange(t.max() + 1)
    while True:
        m = label[t].min(1)
        new = label.copy()
        for j in range(3):
            np.minimum.at(new, t[:, j], m)
        new = new[new]  # сжатие путей
        if np.array_equal(new, label):
            break
        label = new
    comp = label[t[:, 0]]
    pts = v[tri]
    _, ci = np.unique(comp, return_inverse=True)
    lo = np.full((ci.max() + 1, 3), np.inf)
    hi = np.full((ci.max() + 1, 3), -np.inf)
    np.minimum.at(lo, ci, pts.min(1))
    np.maximum.at(hi, ci, pts.max(1))
    big = np.linalg.norm(hi - lo, axis=1) >= min_size
    return tri[big[ci]]


def feature_edges(v, tri, angle):
    """Рёбра, где соседние грани расходятся больше чем на angle, и открытые края."""
    n = np.cross(v[tri[:, 1]] - v[tri[:, 0]], v[tri[:, 2]] - v[tri[:, 0]])
    ln = np.linalg.norm(n, axis=1)
    keep = ln > 1e-12
    tri, n = tri[keep], n[keep] / ln[keep, None]
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    face = np.tile(np.arange(len(tri)), 3)
    e = np.sort(e, axis=1)
    order = np.lexsort((e[:, 1], e[:, 0]))
    e, face = e[order], face[order]
    same = np.all(e[1:] == e[:-1], axis=1)
    out = []
    # Пары граней с общим ребром
    idx = np.nonzero(same)[0]
    cos = np.einsum("ij,ij->i", n[face[idx]], n[face[idx + 1]])
    sharp = idx[np.abs(cos) < math.cos(math.radians(angle))]
    out.append(e[sharp])
    # Открытые края (ребро у одной грани)
    single = np.ones(len(e), bool)
    single[idx] = False
    single[idx + 1] = False
    out.append(e[single])
    return np.concatenate(out)


def raster(tris2d, to_px, size):
    img = np.zeros(size, np.uint8)
    pts = np.int32(np.round(to_px(tris2d.reshape(-1, 2)))).reshape(-1, 3, 2)
    # По одному: fillPoly со списком заливает пересечения по правилу чётности
    for t in pts:
        cv2.fillConvexPoly(img, t, 255)
    return img


def register(walls_ifc, plan):
    """Сдвиг (dx, dz): plan_x = ifc_x + dx, plan_z = -ifc_y + dz. Корреляция контуров стен."""
    polys = [np.array(p["outer"]) for k in ("wallsOuter", "wallsInner", "wallsHall") for p in plan[k]]
    lo = np.min([p.min(0) for p in polys], axis=0) - 3
    hi = np.max([p.max(0) for p in polys], axis=0) + 3
    ifc2d = walls_ifc[:, :, :2] * [1, -1]
    ilo, ihi = ifc2d.reshape(-1, 2).min(0) - 3, ifc2d.reshape(-1, 2).max(0) + 3

    def match(scale, around=None, radius=None):
        size = lambda a, b: (int((b[1] - a[1]) * scale) + 1, int((b[0] - a[0]) * scale) + 1)
        a = raster(ifc2d, lambda p: (p - ilo) * scale, size(ilo, ihi))
        b = np.zeros(size(lo, hi), np.uint8)
        cv2.fillPoly(b, [np.int32(np.round((p - lo) * scale)) for p in polys], 255)
        prep = lambda m: cv2.GaussianBlur(cv2.Canny(m, 50, 150).astype(np.float32), (0, 0), 1.5)
        a, b = prep(a), prep(b)
        if a.shape[0] < b.shape[0] or a.shape[1] < b.shape[1]:
            pad = ((0, max(0, b.shape[0] - a.shape[0])), (0, max(0, b.shape[1] - a.shape[1])))
            a = np.pad(a, pad)
        r = cv2.matchTemplate(a, b, cv2.TM_CCORR_NORMED)
        if around is not None:
            # Ищем только рядом с грубым ответом
            cx, cy = (np.array(around) - ilo + lo) * scale
            mask = np.zeros_like(r)
            y0, y1 = int(max(cy - radius * scale, 0)), int(cy + radius * scale) + 1
            x0, x1 = int(max(cx - radius * scale, 0)), int(cx + radius * scale) + 1
            mask[y0:y1, x0:x1] = 1
            r = r * mask
        _, score, _, (px, py) = cv2.minMaxLoc(r)
        # Смещение начала плана в координатах IFC-картинки → сдвиг
        off = np.array([px, py]) / scale + ilo - lo  # ifc (x, -y) = plan + off
        return off, score

    coarse, _ = match(10)
    fine, score = match(40, around=coarse, radius=0.5)
    return -fine[0], -fine[1], score


def main():
    # Консоль Windows бывает в cp1251 — отчёт не должен ронять сборку
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ifc_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IFC
    if not ifc_path.exists():
        print(f"school (IFC): файл не найден — {ifc_path}; макет не обновлён")
        return
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    parts, levels = tessellate(ifc_path)

    # ── Совмещение с планом ──
    all_v = np.concatenate([v for *_, v, _ in parts])
    floor0 = levels[0] if levels else 0.0
    walls = []  # треугольники, пересекающие срез (контуры стен)
    ground = []  # все треугольники элементов, стоящих на 1-м этаже (сечения залиты)
    for cls, _, v, tri in parts:
        if cls in ("IfcWall", "IfcWallStandardCase", "IfcColumn"):
            t = v[tri]
            z = t[:, :, 2]
            hit = (z.min(1) <= floor0 + SCAN_Y) & (z.max(1) >= floor0 + SCAN_Y)
            walls.append(t[hit])
            if hit.any():
                ground.append(t)
    walls = np.concatenate(walls)
    ground = np.concatenate(ground)
    dx, dz, score = register(walls, plan)
    # Ноль по высоте — пол 1-го этажа: карточка и есть земля. По нижней точке
    # всего IFC здание вставало на невидимый цоколь (фундаментная плита) и
    # казалось висящим; теперь плита уходит внутрь карточки.
    base = floor0
    to_plan = lambda p: np.stack([p[..., 0] + dx, p[..., 2] - base, -p[..., 1] + dz], axis=-1)

    # План (м) → карточка: как в make-school-model.mjs (makeTranslation · rotY(-θ) · scale k)
    tr = plan["transform"]
    k, th, ox, oz = tr["k"], tr["theta"], tr["ox"], tr["oz"]
    c, s = math.cos(-th), math.sin(-th)

    def to_card(p):
        x, y, z = p[..., 0] * k, p[..., 1] * k, p[..., 2] * k
        return np.stack([c * x + s * z + ox, y, -s * x + c * z + oz], axis=-1)

    # Всё, что целиком на уровне земли и ниже, прячет карточка: фундаментная плита
    # и верхняя грань плиты 1-го этажа. Без этого внутри здания вместо бордовой
    # земли светлый пол (и мерцание — грань лежит ровно в плоскости карточки).
    parts = [
        (cls, mat, v, tri[keep])
        for cls, mat, v, tri in parts
        for keep in [v[tri][:, :, 2].max(1) > floor0 + 0.001]
        if keep.any()
    ]

    # ── Корзины ──
    buckets = {}
    for cls, mat, v, tri in parts:
        if cls in GRID_SMALL:
            tri = drop_small_pieces(v, tri, MIN_PIECE)
            if not len(tri):
                continue
        used, t = np.unique(tri, return_inverse=True)
        buckets.setdefault(mat, {}).setdefault(GRID_SMALL.get(cls, GRID), []).append((v[used], t.reshape(-1, 3)))
    meshes = []
    edge_segs = []
    tris_in = tris_out = 0
    for mat in sorted(buckets):
        vs, ts, off = [], [], 0
        for grid, group in buckets[mat].items():
            gv = np.concatenate([v for v, _ in group])
            gt = np.concatenate([t + o for (_, t), o in zip(group, np.cumsum([0] + [len(v) for v, _ in group[:-1]]))])
            tris_in += len(gt)
            gv, gt = simplify(to_plan(gv), gt, grid)
            vs.append(gv)
            ts.append(gt + off)
            off += len(gv)
        v, t = np.concatenate(vs), np.concatenate(ts)
        tris_out += len(t)
        if mat in EDGE_MATS:
            e = feature_edges(v, t, EDGE_ANGLE)
            edge_segs.append(v[e])
        meshes.append((mat, 4, to_card(v), t))
    segs = np.concatenate(edge_segs)
    ev = segs.reshape(-1, 3)
    meshes.append(("edges", 1, to_card(ev), np.arange(len(ev)).reshape(-1, 2)))

    glb = write_glb(meshes)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DEBUG_DIR.mkdir(exist_ok=True)
    raw = DEBUG_DIR / "school-ifc-raw.glb"
    raw.write_bytes(glb)
    packed = pack(raw, OUT_DIR / "model.glb")

    # ── Метаданные: контур кровли (вписывание камеры) и срез стен 1-го этажа («печать») ──
    SC = 50  # px на метр
    wplan = to_plan(ground)[:, :, [0, 2]]
    solid = ("IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcColumn", "IfcPlate", "IfcMember")
    allplan = np.concatenate([to_plan(v[t])[:, :, [0, 2]] for cls, _, v, t in parts if cls in solid])
    lo = allplan.reshape(-1, 2).min(0) - 1
    hi = allplan.reshape(-1, 2).max(0) + 1
    size = (int((hi[1] - lo[1]) * SC) + 1, int((hi[0] - lo[0]) * SC) + 1)
    to_px = lambda p: (p - lo) * SC
    from_px = lambda p: p / SC + lo

    def rings(mask, eps, mode):
        cs, _ = cv2.findContours(mask, mode, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for cnt in cs:
            if cv2.contourArea(cnt) < 4:
                continue
            a = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2).astype(np.float64)
            if len(a) < 3:
                continue
            pc = to_card(np.stack([from_px(a)[:, 0], np.zeros(len(a)), from_px(a)[:, 1]], axis=-1))
            out.append([[round(float(x), 5), round(float(z), 5)] for x, _, z in pc])
        return out

    foot = raster(allplan, to_px, size)
    foot = cv2.morphologyEx(foot, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    outline = rings(foot, 6, cv2.RETR_EXTERNAL)
    outline.sort(key=len, reverse=True)
    wall_mask = raster(wplan, to_px, size)
    scan = rings(wall_mask, 1.5, cv2.RETR_CCOMP)

    card = to_card(to_plan(all_v))
    write_plate(to_card(to_plan(ground))[:, :, [0, 2]], OUT_DIR / "plate.png")
    meta = {
        "format": 2,
        "model": "model.glb",
        "height": round(float(card[:, 1].max()), 5),
        "bounds": [
            [round(float(card[:, 0].min()), 5), round(float(card[:, 2].min()), 5)],
            [round(float(card[:, 0].max()), 5), round(float(card[:, 2].max()), 5)],
        ],
        # Пол 1-го этажа: «печать» начинается отсюда (после сдвига — сама карточка),
        # иначе секущая плоскость надолго остаётся внутри плиты и показывает её изнанку
        "base": max(0.0, round(float(to_card(np.array([[0.0, floor0 - base, 0.0]]))[0, 1]), 5)),
        "outline": outline[:1],
        "scan": scan,
        "buildMs": 3800,
        "source": ifc_path.name,
    }
    (OUT_DIR / "model.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ── Контроль: стены IFC (белые) поверх плана из PDF (красный) ──
    dbg = cv2.cvtColor(foot // 4, cv2.COLOR_GRAY2BGR)
    for key in ("wallsOuter", "wallsInner", "wallsHall"):
        for p in plan[key]:
            cv2.polylines(dbg, [np.int32(to_px(np.array(p["outer"])))], True, (60, 60, 230), 2)
    dbg[wall_mask > 0] = (235, 235, 235)
    cv2.imwrite(str(DEBUG_DIR / "school-ifc.png"), dbg)

    kb = lambda n: f"{round(n / 1024)} КБ"
    print(
        f"school (IFC): {len(parts)} частей, сдвиг ({dx:.3f}, {dz:.3f}) м, совпадение {score:.2f}; "
        f"{round(tris_in / 1000)} → {round(tris_out / 1000)} тыс. треугольников, "
        f"{round(len(segs) / 1000)} тыс. рёбер, model.glb {kb(len(glb))} → {kb(packed)}, высота {meta['height']}"
    )


def write_plate(walls_card, dst, slug="school"):
    """Иконка без надписей (clean_plate из make-models.py) и без линий плана;
    поверх — план 1-го этажа (срез стен) цветом линий иконки. Общая с make-flat-ifc.py."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("make_models", ROOT / "scripts" / "make-models.py")
    mm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mm)
    img = cv2.imread(str(ROOT / f"public/icons/{slug}-dark.png"), cv2.IMREAD_UNCHANGED)
    pal = mm.load_palette()[slug]
    ink, bg = mm.hex_to_bgr(pal["ink"]), mm.hex_to_bgr(pal["bg"])
    plate = mm.clean_plate(img)
    size = img.shape[1]

    # Линии плана (со сглаженными краями) закрашиваем фоном карточки
    bgr = img[:, :, :3].astype(np.float32)
    d = ink - bg
    t = ((bgr - bg) @ d) / float(d @ d)
    x0, y0, x1, y1 = mm.PLAN_BOX
    lines = np.zeros(t.shape, np.uint8)
    lines[y0:y1, x0:x1] = (t[y0:y1, x0:x1] > 0.08) * 255
    lines = cv2.dilate(lines, np.ones((3, 3), np.uint8))
    fill = np.median(img[y0 + 20 : y0 + 40, x0 + 20 : x0 + 60, :3].reshape(-1, 3), axis=0)
    line_color = np.median(bgr[t > 0.9].reshape(-1, 3), axis=0)
    plate[lines > 0, :3] = fill.astype(np.uint8)

    # План 1-го этажа: рисуем в 4× и уменьшаем — края сглажены, как у иконки
    SS = 4
    big = np.zeros((size * SS, size * SS), np.uint8)
    px = np.int32(np.round((walls_card + 0.5) * size * SS))
    for tri in px:
        cv2.fillConvexPoly(big, tri, 255)
    # Стены на иконке нарисованы чуть толще масштаба — немного утолщаем
    big = cv2.dilate(big, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    a = cv2.resize(big, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)[:, :, None] / 255
    rgb = plate[:, :, :3].astype(np.float32)
    plate[:, :, :3] = np.round(rgb * (1 - a) + line_color * a).astype(np.uint8)
    cv2.imwrite(str(dst), plate)


def pack(src, dst):
    """gltfpack из node_modules: -cc — meshopt, -kn/-km — сохранить имена узлов и материалов,
    -si — упрощение до SIMPLIFY треугольников (на макете разница почти не видна, а кадр в разы легче),
    -vp 16 — точность координат: при 14 битах плоскости «дрожат» и секущая плоскость рвёт их край."""
    exe = shutil.which("gltfpack", path=str(ROOT / "node_modules" / ".bin")) or shutil.which("gltfpack")
    if not exe:
        print("gltfpack не найден (npm install) — model.glb записан без сжатия")
        shutil.copyfile(src, dst)
    else:
        args = [exe, "-i", str(src), "-o", str(dst), "-cc", "-kn", "-km", "-vp", "16"]
        if SIMPLIFY < 1:
            args += ["-si", str(SIMPLIFY)]
        subprocess.run(args, check=True, capture_output=True)
    return dst.stat().st_size


def write_glb(items):
    """Минимальный GLB (как в make-school-model.mjs): позиции и индексы, по мешу на материал."""
    bin_parts, views, accessors = [], [], []
    gltf = {
        "asset": {"version": "2.0", "generator": "make-school-ifc"},
        "scene": 0,
        "scenes": [{"nodes": []}],
        "nodes": [],
        "meshes": [],
        "materials": [],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [],
    }
    offset = 0

    def push(data, target):
        nonlocal offset
        b = data.tobytes()
        pad = (-len(b)) % 4
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(b), "target": target})
        bin_parts.append(b + b"\0" * pad)
        offset += len(b) + pad
        return len(views) - 1

    for name, mode, pos, idx in items:
        pos = pos.astype(np.float32)
        pv = push(pos, 34962)
        accessors.append(
            {
                "bufferView": pv,
                "componentType": 5126,
                "count": len(pos),
                "type": "VEC3",
                "min": pos.min(0).tolist(),
                "max": pos.max(0).tolist(),
            }
        )
        pa = len(accessors) - 1
        big = len(pos) > 65535
        iv = push(idx.reshape(-1).astype(np.uint32 if big else np.uint16), 34963)
        accessors.append({"bufferView": iv, "componentType": 5125 if big else 5123, "count": int(idx.size), "type": "SCALAR"})
        gltf["materials"].append(
            {"name": name, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1}}
        )
        gltf["meshes"].append(
            {
                "name": name,
                "primitives": [{"attributes": {"POSITION": pa}, "indices": len(accessors) - 1, "mode": mode, "material": len(gltf["materials"]) - 1}],
            }
        )
        gltf["nodes"].append({"name": name, "mesh": len(gltf["meshes"]) - 1})
        gltf["scenes"][0]["nodes"].append(len(gltf["nodes"]) - 1)
    gltf["buffers"].append({"byteLength": offset})
    body = b"".join(bin_parts)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(body)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(js), 0x4E4F534A)
        + js
        + struct.pack("<II", len(body), 0x004E4942)
        + body
    )


if __name__ == "__main__":
    main()
