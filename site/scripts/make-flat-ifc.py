"""
3D-макет двухкомнатной квартиры из экспорта Revit (IFC) → public/projects/flat/model.glb (+ model.json, plate.png).

Замена процедурного макета по линиям иконки (make-models.py). Общие шаги — из
make-school-ifc.py (триангуляция, упрощение, рёбра, GLB, gltfpack, plate.png):
  1. В файле, кроме квартиры, лежат библиотека мебели и легенды листов — берём
     только элементы, центр которых внутри APT_BOX.
  2. Потолок снимаем: перекрытие над квартирой, подвесные потолки и всё, что
     инженерка целиком выше CEILING_Z (светильники, решётки), — иначе сверху виден
     только потолок. Мелочь инженерии (розетки, выключатели, выводы труб,
     светодиодные ленты, плинтусы) на карточке не видна — тоже убираем.
  3. Элементы раскладываются по материалам ProjectModel по классу IFC и названию
     типа (стены, отделка, мебель, мягкая мебель, сантехника, стекло…).
  4. Скрытые грани на стыках стен и под отделкой вырезаются (remove_internal),
     всё обрезается по верху стен WALL_TOP, входная дверь рисуется заново (entrance_door).
  5. Совмещение с карточкой: масштаб и сдвиг подбираются корреляцией срезов
     существующих (несущих) стен с толстыми линиями иконки.

Запуск: python scripts/make-flat-ifc.py [путь к .ifc]   (нужны ifcopenshell, numpy, opencv-python-headless)
Путь по умолчанию — FLAT_IFC или файл в assets/revit files (в репозиторий не кладём).
Контроль совмещения — .model-debug/flat-ifc.png.
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "projects" / "flat"
DEBUG_DIR = ROOT / ".model-debug"
DEFAULT_IFC = Path(
    os.environ.get(
        "FLAT_IFC",
        ROOT.parent / "assets" / "revit files" / "Interiors working drawings" / "двухкомнатная квартира" / "двухкомнатная квартира.ifc",
    )
)


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ifc = load("make_school_ifc", "make-school-ifc.py")
mm = load("make_models", "make-models.py")

# Квартира в координатах IFC (м): x0, y0, x1, y1
APT_BOX = (2.7, 14.8, 10.6, 23.4)
# Отметка чистого пола (этаж «1 этаж»)
FLOOR0 = 0.0
# Инженерка целиком выше — потолочная (светильники, решётки, выводы), м. Только для
# CEILING_CLASSES: у мебели там верх молдингов и карнизов, у витража — верхний ряд
# панелей и импостов, у стен — балки над проёмами (раньше срезались, молдинги
# выглядели недоделанными).
CEILING_Z = 2.3
CEILING_CLASSES = {"IfcFlowTerminal", "IfcFlowFitting", "IfcBuildingElementProxy"}
# Высота среза для «печати» и совмещения, м
SCAN_Y = 1.2
GRID = 0.01
# Door — нарисованная входная дверь (entrance_door): детали по 6–20 мм
GRID_SMALL = {"IfcDoor": 0.03, "IfcWindow": 0.025, "Door": 0.001}
# Верх стен, м. Витраж и перегородки из блока (Стена_монт_Блок_120) в IFC идут
# до 3,3 м (до перекрытия) и торчали над стенами — всё обрезаем по этой отметке
WALL_TOP = 3.0
# Входная дверь из IFC (плоская плита без коробки) — заменяется на entrance_door()
ENTRANCE = "дверь_глухая"
# Куски мельче (ручки, петли, крепёж) у этих классов отбрасываются, м
MIN_PIECE = {"IfcDoor": 0.12, "IfcWindow": 0.12, "IfcFurnishingElement": 0.05, "IfcFlowTerminal": 0.05}
EDGE_ANGLE = 30
EDGE_MATS = {"wall", "panel", "tile", "slab", "furn", "wood", "white"}
# Стены и отделка: рёбра на стыках соседних элементов (торец стены у ровной
# глади соседней) убираются — seam_filter
FLAT_MATS = ("wall", "panel", "tile")
SKIP = {
    "IfcOpeningElement", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcSite", "IfcBuilding", "IfcBuildingStorey",
    "IfcCovering", "IfcRailing", "IfcFlowFitting", "IfcFlowController", "IfcDistributionPort",
}
WALLS = ("IfcWall", "IfcWallStandardCase")
SOFT = ("диван", "кровать", "кресло", "козетка", "armchair", "chair", "sofa", "лежан", "пуф")
SANITARY = ("унитаз", "мойка", "раковин", "ванна", "душ", "биде", "сантех")


def bucket(cls, name, rgb, transparency):
    """Материал ProjectModel для элемента; None — элемент не нужен."""
    n = name.lower()
    lum = sum(rgb) / 3
    if cls in WALLS:
        if "потолок" in n:
            return None  # обшивка потолка
        if "сущ" in n or "монт" in n:
            return "wall"
        return "panel" if lum > 0.8 else "tile"  # отделка стен: покраска / плитка
    if cls == "IfcDoor" and "дверь_универсальная" in n:
        return None  # откатное полотно у стены с телевизором торчало отдельной плитой (просьба заказчика)
    if cls in ("IfcDoor", "IfcWindow", "IfcPlate", "IfcMember"):
        return ifc.bucket(cls, rgb, transparency)
    if cls == "IfcSlab":
        return "white" if "подоконник" in n else None  # полы — это сама карточка, перекрытие сверху снимаем
    if cls == "IfcBuildingElementProxy":
        return "metal" if "радиатор" in n else None  # выключатели, решётки
    if cls == "IfcFlowTerminal":
        # Светильники висят на снятом потолке (подвесной над столом кухни парил в воздухе)
        if "светодиод" in n or "лента" in n or "светильник" in n:
            return None
        if any(k in n for k in SANITARY):
            return "metal" if "смесител" in n else "white"
        return "metal"
    if cls == "IfcFurnishingElement":
        if transparency > 0.2:
            return "glass"
        if lum < 0.2:
            return "dark"  # встроенная техника
        if rgb[0] > rgb[2] + 0.15:
            return "wood"
        if any(k in n for k in SOFT):
            return "fabric"
        return "furn"
    return "wall"


def tessellate(path):
    import ifcopenshell
    import ifcopenshell.geom

    f = ifcopenshell.open(str(path))
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    it = ifcopenshell.geom.iterator(settings, f, os.cpu_count() or 4)
    if not it.initialize():
        raise SystemExit("IFC: нет геометрии")
    x0, y0, x1, y1 = APT_BOX
    parts = []  # (класс, название, материал, вершины, треугольники)
    while True:
        shape = it.get()
        el = f.by_id(shape.id)
        cls = el.is_a()
        g = shape.geometry
        v = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
        name = getattr(el, "ObjectType", None) or el.Name or ""
        c = (v.min(0) + v.max(0)) / 2 if len(v) else np.zeros(3)
        ceiling = cls in CEILING_CLASSES and v[:, 2].min() >= FLOOR0 + CEILING_Z if len(v) else False
        if cls not in SKIP and len(v) and x0 < c[0] < x1 and y0 < c[1] < y1 and not ceiling:
            tri = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
            mids = np.asarray(g.material_ids, dtype=np.int64)
            for mi, m in enumerate(g.materials):
                sel = tri[mids == mi]
                if not len(sel):
                    continue
                rgb = tuple(m.diffuse.components) if m.diffuse else (0.8, 0.8, 0.8)
                transp = m.transparency if m.transparency == m.transparency else 0.0
                mat = bucket(cls, name, rgb, transp or 0.0)
                if mat:
                    parts.append((cls, name, mat, v, sel))
        if not it.next():
            break
    return parts


def register(walls):
    """Масштаб (px иконки на метр) и сдвиг: срез несущих стен ↔ толстые линии иконки."""
    img = cv2.imread(str(ROOT / "public/icons/flat-dark.png"), cv2.IMREAD_UNCHANGED)
    pal = mm.load_palette()["flat"]
    thick, _ = mm.split_lines(mm.ink_mask(img, mm.hex_to_bgr(pal["ink"]), mm.hex_to_bgr(pal["bg"])), 9)
    t2 = walls[:, :, :2] * [1, -1]  # план: x, z = -y (z растёт вниз по картинке)
    lo = t2.reshape(-1, 2).min(0)
    tmpl = thick.astype(np.float32)
    best = None
    for s in np.arange(55, 85, 0.25):
        a = np.zeros((int((t2[..., 1].max() - lo[1]) * s) + 3, int((t2[..., 0].max() - lo[0]) * s) + 3), np.uint8)
        for tr in np.int32(np.round((t2 - lo) * s)):
            cv2.fillConvexPoly(a, tr, 255)
        if a.shape[0] >= tmpl.shape[0] or a.shape[1] >= tmpl.shape[1]:
            break
        r = cv2.matchTemplate(tmpl, a.astype(np.float32), cv2.TM_CCORR_NORMED)
        _, score, _, loc = cv2.minMaxLoc(r)
        if best is None or score > best[0]:
            best = (score, s, loc)
    score, s, (px, py) = best
    size = img.shape[1]
    # карточка = px / size - 0.5
    return s / size, (px - lo[0] * s) / size - 0.5, (py - lo[1] * s) / size - 0.5, score, img


def box(x0, x1, y0, y1, z0, z1):
    """Параллелепипед (координаты IFC, м): вершины и треугольники наружу."""
    v = np.array([[(x0, x1)[i & 1], (y0, y1)[i >> 1 & 1], (z0, z1)[i >> 2]] for i in range(8)], float)
    quads = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    t = np.array([tri for a, b, c, d in quads for tri in ((a, b, c), (a, c, d))])
    n = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    flip = np.einsum("ij,ij->i", n, v[t].mean(1) - v.mean(0)) < 0
    t[flip] = t[flip][:, ::-1]
    return v, t


def entrance_door(x0, x1, y_out, y_in, h):
    """Входная дверь в проёме x0…x1 (высота h) стены между y_out (улица) и y_in
    (комната): коробка, наличники с двух сторон, полотно с филёнкой, ручки,
    цилиндр замка и порог. Семейства дверей есть только в .rfa — без Revit
    их геометрию не прочитать, поэтому рисуем сами. [(материал, v, t)]"""
    out = []
    add = lambda mat, *b: out.append((mat, *box(*b)))
    fw, fd = 0.06, 0.14  # коробка: ширина, глубина
    fy0 = y_out + 0.03
    fy1 = fy0 + fd
    add("dark", x0, x0 + fw, fy0, fy1, 0, h)
    add("dark", x1 - fw, x1, fy0, fy1, 0, h)
    add("dark", x0, x1, fy0, fy1, h - fw, h)
    # Наличники 70 мм, 12 мм над плоскостью стены
    cw, ct = 0.07, 0.012
    for y0, y1 in ((y_out - ct, y_out), (y_in, y_in + ct)):
        add("dark", x0 - cw, x0, y0, y1, 0, h + cw)
        add("dark", x1, x1 + cw, y0, y1, 0, h + cw)
        add("dark", x0 - cw, x1 + cw, y0, y1, h, h + cw)
    # Полотно 50 мм посередине коробки, зазоры 2 мм
    lx0, lx1, lz1 = x0 + fw + 0.002, x1 - fw - 0.002, h - fw - 0.002
    ly0 = fy0 + (fd - 0.05) / 2
    ly1 = ly0 + 0.05
    add("wood", lx0, lx1, ly0, ly1, 0.01, lz1)
    # Филёнка: рамка-молдинг 20 мм на обеих сторонах полотна
    mx0, mx1, mz0, mz1, mw, mt = lx0 + 0.12, lx1 - 0.12, 0.25, lz1 - 0.2, 0.02, 0.006
    for y0, y1 in ((ly0 - mt, ly0), (ly1, ly1 + mt)):
        add("dark", mx0, mx0 + mw, y0, y1, mz0, mz1)
        add("dark", mx1 - mw, mx1, y0, y1, mz0, mz1)
        add("dark", mx0, mx1, y0, y1, mz0, mz0 + mw)
        add("dark", mx0, mx1, y0, y1, mz1 - mw, mz1)
    # Ручки-нажимные с накладками (у притвора, на 1 м) и цилиндр замка снаружи
    hx = lx1 - 0.07
    for face, d in ((ly0, -1), (ly1, 1)):
        plate = sorted((face, face + d * 0.012))
        stem = sorted((face + d * 0.012, face + d * 0.045))
        lever = sorted((face + d * 0.045, face + d * 0.065))
        add("metal", hx - 0.022, hx + 0.022, *plate, 0.94, 1.16)
        add("metal", hx - 0.01, hx + 0.01, *stem, 1.035, 1.055)
        add("metal", hx - 0.13, hx + 0.012, *lever, 1.03, 1.06)
    add("metal", hx - 0.012, hx + 0.012, ly0 - 0.016, ly0, 1.2, 1.26)
    add("metal", lx0, lx1, fy0, fy1, 0.0, 0.012)  # порог
    return out


def remove_internal(simple, mats):
    """Убирает скрытые грани: где две грани лежат в одной плоскости вплотную
    «спиной к спине» (торец стены прижат к соседней, отделка к стене), общий
    участок вырезается из обеих. Иначе у готового здания (рисуются только
    лицевые стороны, тени — по обратным) такая грань почти совпадает с фасадом
    и даёт на нём пятнистую полосу тени у стыка стен. Возвращает число плоскостей."""
    import shapely
    from shapely.geometry import Polygon

    groups = {}
    tri_of = {}
    for mat in mats:
        if mat not in simple:
            continue
        v, t = simple[mat]
        P = v[t]
        n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        ln = np.linalg.norm(n, axis=1)
        ok = ln > 1e-10
        n[ok] /= ln[ok, None]
        ax = np.abs(n).argmax(1)
        sign = np.sign(n[np.arange(len(n)), ax])
        c = n * sign[:, None]
        d = np.einsum("ij,ij->i", c, P[:, 0])
        keys = np.column_stack([np.round(c * 200), np.round(d / 0.001)]).astype(np.int64)
        for i in np.nonzero(ok)[0]:
            groups.setdefault(tuple(keys[i]), []).append((mat, i, int(sign[i])))
        tri_of[mat] = (P, c)
    removed = {m: set() for m in tri_of}
    added = {m: [] for m in tri_of}
    planes = 0
    for items in groups.values():
        if len({s for *_, s in items}) < 2:
            continue
        mat0, i0, _ = items[0]
        c = tri_of[mat0][1][i0]
        u = np.cross(c, [0, 0, 1] if abs(c[2]) < 0.9 else [1, 0, 0])
        u /= np.linalg.norm(u)
        w = np.cross(c, u)
        d0 = float(np.mean([tri_of[m][0][i][0] @ c for m, i, _ in items]))
        polys = {}
        for m, i, sd in items:
            q = tri_of[m][0][i]
            pg = Polygon(np.column_stack([q @ u, q @ w]))
            if pg.area > 1e-9:
                polys.setdefault((sd, m), []).append((i, pg))

        def side(sd):
            return shapely.union_all([pg for (s2, _), lst in polys.items() if s2 == sd for _, pg in lst])

        inter = shapely.set_precision(side(1).intersection(side(-1)), 1e-5)
        if inter.area < 1e-6:
            continue
        planes += 1
        for (sd, m), lst in polys.items():
            own = shapely.union_all([pg for _, pg in lst])
            if own.intersection(inter).area < 1e-7:
                continue
            removed[m].update(i for i, _ in lst)
            rest = shapely.set_precision(own.difference(inter), 1e-5)
            for g in getattr(rest, "geoms", [rest]):
                if g.geom_type != "Polygon" or g.area < 1e-7:
                    continue
                for tr in shapely.constrained_delaunay_triangles(g).geoms:
                    xy = np.array(tr.exterior.coords)[:3]
                    q = c * d0 + xy[:, :1] * u + xy[:, 1:2] * w
                    if np.cross(q[1] - q[0], q[2] - q[0]) @ (c * sd) < 0:
                        q = q[::-1]
                    added[m].append(q)
    for m in tri_of:
        if not removed[m] and not added[m]:
            continue
        v, t = simple[m]
        keep = np.ones(len(t), bool)
        keep[list(removed[m])] = False
        new = np.array(added[m]).reshape(-1, 3) if added[m] else np.zeros((0, 3))
        simple[m] = (np.concatenate([v, new]), np.concatenate([t[keep], len(v) + np.arange(len(new)).reshape(-1, 3)]))
    return planes


def seam_filter(v, t, e, surf, eps=0.008, tol=0.004):
    """Убирает рёбра-«швы»: если хотя бы одна из граней у ребра продолжается за
    ним в той же плоскости (поверхностью из surf — треугольники N×3×3 стен и
    отделки), ребро лежит на ровной глади — стык двух стен, а не угол."""
    n = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    # Грани у каждого ребра
    fe = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    ff = np.tile(np.arange(len(t)), 3)
    key = lambda a: np.sort(a, axis=1) @ np.array([len(v), 1])
    fk = key(fe)
    order = np.argsort(fk)
    fk, ff = fk[order], ff[order]
    ek = key(e)
    lo, hi = np.searchsorted(fk, ek, "left"), np.searchsorted(fk, ek, "right")
    qe = np.repeat(np.arange(len(e)), hi - lo)
    qf = ff[np.concatenate([np.arange(a, b) for a, b in zip(lo, hi)])] if len(e) else np.zeros(0, int)
    p0, p1 = v[e[qe, 0]], v[e[qe, 1]]
    mid = (p0 + p1) / 2
    qn = n[qf]
    d = np.cross(qn, p1 - p0)
    d /= np.maximum(np.linalg.norm(d, axis=1), 1e-12)[:, None]
    cen = v[t[qf]].mean(1)
    d[np.einsum("ij,ij->i", d, cen - mid) > 0] *= -1  # от грани наружу
    m = mid + d * eps
    # Треугольники поверхности
    a, b, c = surf[:, 0], surf[:, 1], surf[:, 2]
    sn = np.cross(b - a, c - a)
    sn /= np.maximum(np.linalg.norm(sn, axis=1), 1e-12)[:, None]
    seam = np.zeros(len(e), bool)
    for i in range(0, len(m), 256):
        mm, nn = m[i : i + 256, None], qn[i : i + 256, None]
        same = np.abs((sn[None] * nn).sum(-1)) > 0.995
        near = np.abs(((mm - a[None]) * sn[None]).sum(-1)) < tol
        # Барицентрические координаты точки в плоскости треугольника
        v0, v1, v2 = (c - a)[None], (b - a)[None], mm - a[None]
        d00, d01, d11 = (v0 * v0).sum(-1), (v0 * v1).sum(-1), (v1 * v1).sum(-1)
        d20, d21 = (v2 * v0).sum(-1), (v2 * v1).sum(-1)
        den = np.maximum(d00 * d11 - d01 * d01, 1e-18)
        u, w = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
        inside = (u >= -1e-3) & (w >= -1e-3) & (u + w <= 1 + 1e-3)
        hit = (same & near & inside).any(1)
        np.logical_or.at(seam, qe[i : i + 256], hit)
    return e[~seam]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ifc_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IFC
    if not ifc_path.exists():
        print(f"flat (IFC): файл не найден — {ifc_path}; макет не обновлён")
        return
    parts = tessellate(ifc_path)

    # ── Совмещение: срез существующих стен на SCAN_Y ──
    cut = lambda t: (t[:, :, 2].min(1) <= FLOOR0 + SCAN_Y) & (t[:, :, 2].max(1) >= FLOOR0 + SCAN_Y)
    bearing, ground = [], []
    for cls, name, mat, v, tri in parts:
        if cls in WALLS:
            t = v[tri]
            if cut(t).any():
                ground.append(t)
                if "сущ" in name.lower():
                    bearing.append(t)
    k, ox, oz, score, icon = register(np.concatenate(bearing))
    ground = np.concatenate(ground)

    # IFC (x, y, z) → карточка (x, высота, z)
    to_card = lambda p: np.stack([p[..., 0] * k + ox, (p[..., 2] - FLOOR0) * k, -p[..., 1] * k + oz], axis=-1)

    # Всё на уровне пола и ниже прячет карточка (черновой пол, стяжка)
    parts = [
        (cls, name, mat, v, tri[keep])
        for cls, name, mat, v, tri in parts
        for keep in [v[tri][:, :, 2].max(1) > FLOOR0 + 0.001]
        if keep.any()
    ]
    # Всё — не выше верха стен: витраж и перегородки из блока шли до перекрытия
    # (3,3 м) и торчали над остальными стенами
    parts = [
        (cls, name, mat, np.column_stack([v[:, :2], np.minimum(v[:, 2], WALL_TOP)]), tri)
        for cls, name, mat, v, tri in parts
    ]
    # Входная дверь: вместо плиты из IFC — нарисованная, в том же проёме
    is_entrance = lambda p: p[0] == "IfcDoor" and ENTRANCE in p[1].lower()
    door = [p for p in parts if is_entrance(p)]
    if door:
        lo = np.min([v[t].reshape(-1, 3).min(0) for *_, v, t in door], axis=0)
        hi = np.max([v[t].reshape(-1, 3).max(0) for *_, v, t in door], axis=0)
        # Внутренняя грань стены у проёма — самая дальняя из стен, перекрывающих
        # проём по x и начинающихся у наружной грани двери (монолит + штукатурка)
        y_in = max(
            (
                v[:, 1].max()
                for cls, _, _, v, _ in parts
                if cls in WALLS and v[:, 0].min() <= lo[0] and v[:, 0].max() >= hi[0] and lo[1] - 0.01 <= v[:, 1].min() < lo[1] + 0.5 and v[:, 1].max() - lo[1] < 0.5
            ),
            default=lo[1] + 0.3,
        )
        parts = [p for p in parts if not is_entrance(p)]
        parts += [("Door", "entrance", mat, v, t) for mat, v, t in entrance_door(lo[0], hi[0], lo[1], y_in, hi[2])]

    # ── Корзины ──
    buckets = {}
    for cls, _, mat, v, tri in parts:
        if cls in MIN_PIECE:
            tri = ifc.drop_small_pieces(v, tri, MIN_PIECE[cls])
            if not len(tri):
                continue
        used, t = np.unique(tri, return_inverse=True)
        buckets.setdefault(mat, {}).setdefault(GRID_SMALL.get(cls, GRID), []).append((v[used], t.reshape(-1, 3)))
    meshes, edge_segs, simple = [], [], {}
    tris_in = tris_out = 0
    for mat in sorted(buckets):
        vs, ts, off = [], [], 0
        for grid, group in buckets[mat].items():
            gv = np.concatenate([v for v, _ in group])
            gt = np.concatenate([t + o for (_, t), o in zip(group, np.cumsum([0] + [len(v) for v, _ in group[:-1]]))])
            tris_in += len(gt)
            gv, gt = ifc.simplify(gv, gt, grid)
            vs.append(gv)
            ts.append(gt + off)
            off += len(gv)
        v, t = np.concatenate(vs), np.concatenate(ts)
        simple[mat] = (v, t)
    # Только стены: отделка (ОС, ~1 мм) после склейки сетки GRID — лист нулевой
    # толщины, её лицевая и обратная стороны в одной плоскости, и она вырезалась
    # вместе со стеной под ней (дыры треугольниками в стенах спальни)
    internal = remove_internal(simple, ("wall",))
    for mat, (v, t) in simple.items():
        tris_out += len(t)
        meshes.append((mat, 4, to_card(v), t))
    surf = np.concatenate([v[t] for mat, (v, t) in simple.items() if mat in FLAT_MATS])
    seams = 0
    for mat, (v, t) in simple.items():
        if mat in EDGE_MATS:
            e = ifc.feature_edges(v, t, EDGE_ANGLE)
            if mat in FLAT_MATS:
                n0 = len(e)
                e = seam_filter(v, t, e, surf)
                seams += n0 - len(e)
            edge_segs.append(v[e])
    segs = np.concatenate(edge_segs)
    ev = segs.reshape(-1, 3)
    meshes.append(("edges", 1, to_card(ev), np.arange(len(ev)).reshape(-1, 2)))

    glb = ifc.write_glb(meshes)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DEBUG_DIR.mkdir(exist_ok=True)
    raw = DEBUG_DIR / "flat-ifc-raw.glb"
    raw.write_bytes(glb)
    packed = ifc.pack(raw, OUT_DIR / "model.glb")

    # ── Метаданные: контур (вписывание камеры) и срез стен («печать»), в координатах карточки ──
    SC = 50 / k  # px на единицу карточки — 50 px на метр, как у школы
    card_xz = lambda t: to_card(t)[..., [0, 2]]
    solid = WALLS + ("IfcPlate", "IfcMember", "IfcWindow", "IfcDoor")
    allc = np.concatenate([card_xz(v[t]) for cls, _, _, v, t in parts if cls in solid])
    lo = allc.reshape(-1, 2).min(0) - 0.01
    hi = allc.reshape(-1, 2).max(0) + 0.01
    size = (int((hi[1] - lo[1]) * SC) + 1, int((hi[0] - lo[0]) * SC) + 1)
    to_px = lambda p: (p - lo) * SC

    def rings(mask, eps, mode):
        cs, _ = cv2.findContours(mask, mode, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for cnt in cs:
            if cv2.contourArea(cnt) < 4:
                continue
            a = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2).astype(np.float64)
            if len(a) >= 3:
                out.append([[round(float(x), 5), round(float(z), 5)] for x, z in a / SC + lo])
        return out

    foot = ifc.raster(allc, to_px, size)
    foot = cv2.morphologyEx(foot, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    outline = rings(foot, 6, cv2.RETR_EXTERNAL)
    outline.sort(key=len, reverse=True)
    wall_mask = ifc.raster(card_xz(ground), to_px, size)
    scan = rings(wall_mask, 1.5, cv2.RETR_CCOMP)

    card = np.concatenate([to_card(v[t]).reshape(-1, 3) for *_, v, t in parts])
    ifc.write_plate(card_xz(ground), OUT_DIR / "plate.png", slug="flat")
    meta = {
        "format": 2,
        "model": "model.glb",
        "height": round(float(card[:, 1].max()), 5),
        "bounds": [
            [round(float(card[:, 0].min()), 5), round(float(card[:, 2].min()), 5)],
            [round(float(card[:, 0].max()), 5), round(float(card[:, 2].max()), 5)],
        ],
        "base": 0.0,
        "outline": outline[:1],
        "scan": scan,
        "buildMs": 3200,
        "source": ifc_path.name,
    }
    (OUT_DIR / "model.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ── Контроль: срез стен IFC (красный) поверх иконки ──
    n = icon.shape[1]
    dbg = icon[:, :, :3].copy()
    over = np.zeros(dbg.shape[:2], np.uint8)
    for tr in np.int32(np.round((card_xz(ground) + 0.5) * n)):
        cv2.fillConvexPoly(over, tr, 255)
    dbg[over > 0] = (0.4 * dbg[over > 0] + [0, 0, 150]).astype(np.uint8)
    cv2.imwrite(str(DEBUG_DIR / "flat-ifc.png"), dbg)

    kb = lambda b: f"{round(b / 1024)} КБ"
    print(
        f"flat (IFC): {len(parts)} частей, масштаб {k * n:.2f} px/м, совпадение {score:.2f}; "
        f"{round(tris_in / 1000)} → {round(tris_out / 1000)} тыс. треугольников, "
        f"{round(len(segs) / 1000)} тыс. рёбер (швов стен убрано {seams}), скрытых стыков {internal}, model.glb {kb(len(glb))} → {kb(packed)}, высота {meta['height']}; "
        f"материалы: {', '.join(sorted(buckets))}"
    )


if __name__ == "__main__":
    main()
