"""
3D-макет дома повышенной этажности из экспорта Revit (IFC) → public/projects/tower/model.glb (+ model.json, plate.png).

Замена процедурного макета по линиям иконки (make-models.py). Общие шаги — из
make-school-ifc.py (триангуляция, упрощение, рёбра, GLB, gltfpack, plate.png):
  1. Берётся всё здание; помещения, проёмы и всё, что целиком на уровне земли
     и ниже (фундамент), выбрасываются — карточка и есть земля. Ноль — «Уровень
     земли» (−0.9), а не пол 1-го этажа: иначе цоколь и входные ступени уходили
     в карточку и здание казалось посаженным в землю.
  2. Элементы раскладываются по материалам ProjectModel по классу IFC и цвету
     стиля (стены, отделка фасада, перекрытия, кровля, лестницы, окна, двери, ограждения).
  3. Совмещение с карточкой: масштаб и сдвиг подбираются корреляцией среза стен
     (1-го или типового этажа — какой лучше совпадёт) с толстыми линиями иконки.
  4. Навес на кровле (скатные кровли на стойках) в Revit — импортированная
     геометрия («Обозначение импорта»), в IFC она не попадает. Берём её из FBX
     того же 3D-вида (координаты совпадают с IFC): Blender выгружает объект в .npz
     (scripts/blender-fbx-extract.py, кэш — .model-debug/tower-canopy.npz).
     Материала у импорта нет — листы и стойки различаются по наклону граней.

Запуск: python scripts/make-tower-ifc.py [путь к .ifc]   (нужны ifcopenshell, numpy, opencv-python-headless;
для навеса — Blender, путь BLENDER или стандартная установка)
Пути по умолчанию — TOWER_IFC / TOWER_FBX или самый новый .ifc / .fbx в assets/revit files/дом повышенной
этажности (в репозиторий не кладём).
Контроль совмещения — .model-debug/tower-ifc.png.
"""

import glob
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "projects" / "tower"
DEBUG_DIR = ROOT / ".model-debug"
SRC_DIR = ROOT.parent / "assets" / "revit files" / "дом повышенной этажности"
BLENDER = os.environ.get("BLENDER", r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe")
# Навес в FBX — объект импортированной геометрии
CANOPY_PREFIX = "Обозначение импорта"
# Грань наклонена сильнее этого (|nz|) — лист кровли навеса, иначе — стойка, балка, торец
CANOPY_SHEET_NZ = 0.3


def newest(ext, env):
    if os.environ.get(env):
        return Path(os.environ[env])
    files = sorted(glob.glob(str(SRC_DIR / f"*.{ext}")), key=os.path.getmtime)
    return Path(files[-1]) if files else None


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ifc = load("make_school_ifc", "make-school-ifc.py")
mm = load("make_models", "make-models.py")

# Отметка чистого пола 1-го этажа («Этаж 01») и уровня земли («Уровень земли»), м
FLOOR0 = 0.0
GROUND = -0.9
# Высоты срезов для совмещения (1-й и типовой этаж) и «печати», м
SCAN_Y = 1.2
REG_Z = (1.2, 4.2)
# Масштаб иконки, px на метр — диапазон поиска
SCALES = np.arange(17, 27, 0.2)
GRID = 0.01
# Навес: импорт сильно раздроблен (549 тыс. треугольников) — склейка крупнее
CANOPY_GRID = 0.05
# Изделий много (324 межкомнатные двери, 240 окон) — сетка крупнее, чем у школы
GRID_SMALL = {"IfcDoor": 0.04, "IfcWindow": 0.03, "IfcRailing": 0.03, "Canopy": CANOPY_GRID}
# Куски мельче (ручки, петли, крепёж) у этих классов отбрасываются, м
MIN_PIECE = {"IfcDoor": 0.15, "IfcWindow": 0.12, "IfcRailing": 0.05}
EDGE_ANGLE = 30
EDGE_MATS = {"wall", "panel", "slab", "stair"}
SKIP = {"IfcOpeningElement", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcSite", "IfcBuilding", "IfcBuildingStorey"}
WALLS = ("IfcWall", "IfcWallStandardCase")


def bucket(cls, name, rgb, transparency):
    """Материал ProjectModel для элемента."""
    if cls in ("IfcSlab", "IfcRoof"):
        return "stair" if "лестниц" in name.lower() else "slab"  # площадки лестниц — к маршам
    return ifc.bucket(cls, rgb, transparency)


def tessellate(path):
    import ifcopenshell
    import ifcopenshell.geom

    f = ifcopenshell.open(str(path))
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    it = ifcopenshell.geom.iterator(settings, f, os.cpu_count() or 4)
    if not it.initialize():
        raise SystemExit("IFC: нет геометрии")
    parts = []  # (класс, материал, вершины, треугольники)
    while True:
        shape = it.get()
        el = f.by_id(shape.id)
        cls = el.is_a()
        g = shape.geometry
        v = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
        name = getattr(el, "ObjectType", None) or el.Name or ""
        if cls not in SKIP and len(v) and v[:, 2].max() > GROUND + 0.001:
            tri = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
            mids = np.asarray(g.material_ids, dtype=np.int64)
            for mi, m in enumerate(g.materials):
                sel = tri[mids == mi]
                if not len(sel):
                    continue
                rgb = tuple(m.diffuse.components) if m.diffuse else (0.8, 0.8, 0.8)
                transp = m.transparency if m.transparency == m.transparency else 0.0
                parts.append((cls, bucket(cls, name, rgb, transp or 0.0), v, sel))
        if not it.next():
            break
    return parts


def register(walls):
    """Масштаб (доля карточки на метр), сдвиг и оценка: срез стен ↔ толстые линии иконки."""
    img = cv2.imread(str(ROOT / "public/icons/tower-dark.png"), cv2.IMREAD_UNCHANGED)
    pal = mm.load_palette()["tower"]
    thick, _ = mm.split_lines(mm.ink_mask(img, mm.hex_to_bgr(pal["ink"]), mm.hex_to_bgr(pal["bg"])), 7)
    t2 = walls[:, :, :2] * [1, -1]  # план: x, z = -y (z растёт вниз по картинке)
    lo = t2.reshape(-1, 2).min(0)
    tmpl = cv2.GaussianBlur(thick.astype(np.float32), (0, 0), 2)
    best = None
    for s in SCALES:
        a = np.zeros((int((t2[..., 1].max() - lo[1]) * s) + 3, int((t2[..., 0].max() - lo[0]) * s) + 3), np.uint8)
        for tr in np.int32(np.round((t2 - lo) * s)):
            cv2.fillConvexPoly(a, tr, 255)
        if a.shape[0] >= tmpl.shape[0] or a.shape[1] >= tmpl.shape[1]:
            break
        r = cv2.matchTemplate(tmpl, cv2.GaussianBlur(a.astype(np.float32), (0, 0), 2), cv2.TM_CCORR_NORMED)
        _, score, _, loc = cv2.minMaxLoc(r)
        if best is None or score > best[0]:
            best = (score, s, loc)
    score, s, (px, py) = best
    size = img.shape[1]
    # карточка = px / size - 0.5
    return s / size, (px - lo[0] * s) / size - 0.5, (py - lo[1] * s) / size - 0.5, score, img


def wall_cut(parts, z):
    """Треугольники стен, пересекающие отметку z (сечения залиты целиком)."""
    out = []
    for cls, _, v, tri in parts:
        if cls in WALLS:
            t = v[tri]
            if ((t[:, :, 2].min(1) <= z) & (t[:, :, 2].max(1) >= z)).any():
                out.append(t)
    return np.concatenate(out)


def canopy():
    """Навес из FBX: части (класс, материал, вершины, треугольники); [] — нет FBX или Blender."""
    fbx = newest("fbx", "TOWER_FBX")
    if not fbx or not fbx.exists():
        print("tower: FBX не найден — навес на кровле не добавлен")
        return []
    cache = DEBUG_DIR / "tower-canopy.npz"
    if not cache.exists() or cache.stat().st_mtime < fbx.stat().st_mtime:
        if not Path(BLENDER).exists():
            print(f"tower: Blender не найден ({BLENDER}) — навес на кровле не добавлен")
            return []
        DEBUG_DIR.mkdir(exist_ok=True)
        script = ROOT / "scripts" / "blender-fbx-extract.py"
        subprocess.run([BLENDER, "-b", "--python", str(script), "--", str(fbx), str(cache), CANOPY_PREFIX], check=True, capture_output=True)
    d = np.load(cache)
    v, tri = d["verts"], d["tris"]
    n = np.cross(v[tri[:, 1]] - v[tri[:, 0]], v[tri[:, 2]] - v[tri[:, 0]])
    nz = np.abs(n[:, 2]) / np.maximum(np.linalg.norm(n, axis=1), 1e-12)
    sheet = nz > CANOPY_SHEET_NZ
    return [("Canopy", "dark", v, tri[sheet]), ("Canopy", "metal", v, tri[~sheet])]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ifc_path = Path(sys.argv[1]) if len(sys.argv) > 1 else newest("ifc", "TOWER_IFC")
    if not ifc_path or not ifc_path.exists():
        print(f"tower (IFC): файл не найден — {ifc_path}; макет не обновлён")
        return
    parts = tessellate(ifc_path)

    # ── Совмещение: срез стен 1-го или типового этажа — что лучше совпадёт с иконкой ──
    k, ox, oz, score, icon = max((register(wall_cut(parts, FLOOR0 + z)) for z in REG_Z), key=lambda r: r[3])
    ground = wall_cut(parts, FLOOR0 + SCAN_Y)

    # IFC (x, y, z) → карточка (x, высота, z)
    to_card = lambda p: np.stack([p[..., 0] * k + ox, (p[..., 2] - GROUND) * k, -p[..., 1] * k + oz], axis=-1)

    parts += canopy()

    # Всё на уровне земли и ниже прячет карточка (фундамент)
    parts = [
        (cls, mat, v, tri[keep])
        for cls, mat, v, tri in parts
        for keep in [v[tri][:, :, 2].max(1) > GROUND + 0.001]
        if keep.any()
    ]

    # ── Корзины ──
    buckets = {}
    for cls, mat, v, tri in parts:
        if cls in MIN_PIECE:
            tri = ifc.drop_small_pieces(v, tri, MIN_PIECE[cls])
            if not len(tri):
                continue
        used, t = np.unique(tri, return_inverse=True)
        buckets.setdefault(mat, {}).setdefault(GRID_SMALL.get(cls, GRID), []).append((v[used], t.reshape(-1, 3)))
    meshes, edge_segs = [], []
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
        tris_out += len(t)
        if mat in EDGE_MATS:
            edge_segs.append(v[ifc.feature_edges(v, t, EDGE_ANGLE)])
        meshes.append((mat, 4, to_card(v), t))
    segs = np.concatenate(edge_segs)
    ev = segs.reshape(-1, 3)
    meshes.append(("edges", 1, to_card(ev), np.arange(len(ev)).reshape(-1, 2)))

    glb = ifc.write_glb(meshes)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DEBUG_DIR.mkdir(exist_ok=True)
    raw = DEBUG_DIR / "tower-ifc-raw.glb"
    raw.write_bytes(glb)
    packed = ifc.pack(raw, OUT_DIR / "model.glb")

    # ── Метаданные: контур кровли (вписывание камеры) и срез стен 1-го этажа («печать») ──
    SC = 50 / k  # px на единицу карточки — 50 px на метр, как у школы
    card_xz = lambda t: to_card(t)[..., [0, 2]]
    solid = WALLS + ("IfcSlab", "IfcColumn", "IfcPlate", "IfcMember")
    allc = np.concatenate([card_xz(v[t]) for cls, _, v, t in parts if cls in solid])
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
    ifc.write_plate(card_xz(ground), OUT_DIR / "plate.png", slug="tower")
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
        "buildMs": 4200,
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
    cv2.imwrite(str(DEBUG_DIR / "tower-ifc.png"), dbg)

    kb = lambda b: f"{round(b / 1024)} КБ"
    print(
        f"tower (IFC): {len(parts)} частей, масштаб {k * n:.2f} px/м, совпадение {score:.2f}; "
        f"{round(tris_in / 1000)} → {round(tris_out / 1000)} тыс. треугольников, "
        f"{round(len(segs) / 1000)} тыс. рёбер, model.glb {kb(len(glb))} → {kb(packed)}, высота {meta['height']}; "
        f"материалы: {', '.join(sorted(buckets))}"
    )


if __name__ == "__main__":
    main()
