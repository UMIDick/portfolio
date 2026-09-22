"""
Строит данные 3D-моделей проектов из иконок-планов.

Линии плана на иконке (`public/icons/<slug>-dark.png`) превращаются в контуры
стен (полигоны с отверстиями), а силуэт плана — в контур перекрытий.
Результат: `public/projects/<slug>/model.json`, его читает components/ProjectModel,
и `plate.png` — та же иконка без надписей (верх 3D-карточки).

Координаты нормированы по стороне иконки: x и z в диапазоне [-0.5, 0.5],
центр карточки — (0, 0), z растёт вниз по картинке.

Запуск: python scripts/make-models.py   (нужны numpy и opencv-python-headless)
"""
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent

# Область плана на иконке (между шапкой с названием и номерами листов), px
PLAN_BOX = (40, 230, 1150, 1050)  # x0, y0, x1, y1
# Строки линии под названием (с запасом на сглаживание), px
HEADER_LINE = (192, 212)

# Параметры построения для каждого проекта
PROJECTS = {
# slab_close — насколько широкие проёмы замыкать в силуэте перекрытий, px;
# exclude — области (px на иконке), которые не застроены: двор школы вместе
# с галереей-переходом (галерея станет одноэтажной пристройкой).
# windows — окна на глухих участках фасада (доли этажа; шаг — px на иконке),
# по фасадам с листов-презентаций: у школы узкие высокие, у башни — квадратные.
# blank — области без окон на фасаде.
# lifted — область, поднятая на V-образные опоры (первый этаж без стен).
# rail — доля высоты этажа под глухим ограждением остекления (у квартиры окна в пол).
# rim — ширина полосы у края силуэта, где тонкие линии считаются остеклением, px.
# thin_kernel — линии тоньше этого (px) считаются перегородками и остеклением.
# canopy — навес-«корона» на кровле: рамка-пергола (высота над кровлей,
# отступ от края и ширина рамки, px).
# detailed — у проекта детальный макет (model.json, model.glb и plate.png с планом
# 1-го этажа пишут scripts/make-school-ifc.py, make-flat-ifc.py и make-tower-ifc.py): здесь только plate.png для ручного
# макета (make-school-model.mjs) — make-school-ifc.py его перезаписывает.
# Параметры школы остаются — по ним extract-school.py разбирает иконку.
    # Квартира — макет из IFC (scripts/make-flat-ifc.py), здесь только plate.png
    "flat": {"detailed": True, "floors": 1, "floor_h": 0.13, "slab_close": 0, "roof": False, "thin_kernel": 9, "rim": 25, "rail": 0.03},
    "school": {
        "detailed": True,
        "floors": 3,
        "floor_h": 0.07,
        "slab_close": 45,
        "roof": True,
        "exclude": [[(556, 614), (912, 614), (910, 648), (852, 652), (800, 668), (774, 704), (762, 790), (556, 852)]],
        "windows": {"spacing": 34, "width": 0.42, "sill": 0.22, "head": 0.86},
        "lifted": [(760, 700), (1010, 680), (1010, 900), (760, 900)],
        # Концертный зал на фасадах глухой, облицован вертикальными панелями
        "blank": [[(225, 640), (560, 640), (560, 990), (225, 990)]],
    },
    # Башня — макет из IFC (scripts/make-tower-ifc.py), здесь только plate.png
    "tower": {
        "detailed": True,
        "floors": 16,
        "floor_h": 0.042,
        "slab_close": 41,
        "roof": True,
        "windows": {"spacing": 30, "width": 0.5, "sill": 0.3, "head": 0.8},
        "canopy": {"h": 0.035, "inset": 22, "frame": 16},
    },
}

# Линии тоньше этого (px) — перегородки и остекление, толще — несущие стены
THIN_KERNEL = 5
# Минимальная длина глухого участка фасада под окна, px
MIN_FACADE_RUN = 40


def load_palette():
    data = json.loads((ROOT / "content/projects.json").read_text(encoding="utf-8"))
    return {p["slug"]: p["palette"] for p in data}


def hex_to_bgr(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return np.array([b, g, r], dtype=np.float32)


def ink_mask(img, ink, bg):
    """Пиксели, которые ближе к цвету линий, чем к фону."""
    bgr = img[:, :, :3].astype(np.float32)
    alpha = img[:, :, 3]
    d = ink - bg
    t = ((bgr - bg) @ d) / float(d @ d)
    mask = ((t > 0.5) & (alpha > 200)).astype(np.uint8) * 255
    x0, y0, x1, y1 = PLAN_BOX
    clipped = np.zeros_like(mask)
    clipped[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
    return clipped


def to_norm(pts, size):
    return [[round(float(x) / size - 0.5, 5), round(float(y) / size - 0.5, 5)] for x, y in pts]


def polygons(mask, size, eps, min_area):
    """Контуры с отверстиями: [{outer: [...], holes: [[...], ...]}]."""
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]
    result = []
    for i, c in enumerate(contours):
        if hierarchy[i][3] != -1:  # это отверстие — обработаем вместе с внешним контуром
            continue
        if cv2.contourArea(c) < min_area:
            continue
        outer = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(outer) < 3:
            continue
        holes = []
        child = hierarchy[i][2]
        while child != -1:
            hc = contours[child]
            if cv2.contourArea(hc) >= min_area:
                h = cv2.approxPolyDP(hc, eps, True).reshape(-1, 2)
                if len(h) >= 3:
                    holes.append(to_norm(h, size))
            child = hierarchy[child][0]
        result.append({"outer": to_norm(outer, size), "holes": holes})
    return result


def slab_mask(mask, close, exclude):
    """Силуэт здания: закрываем проёмы между стенами, заливаем внутренность
    и вычитаем незастроенные области."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    for poly in exclude:
        cv2.fillPoly(filled, [np.array(poly, dtype=np.int32)], 0)
    # Сглаживаем рваные края после вычитания
    return cv2.morphologyEx(filled, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))


def clean_plate(img):
    """Иконка без надписей и линии под названием: всё внутри рамки вне PLAN_BOX
    закрашивается фоном. Эту картинку 3D-карточка показывает, когда ложится."""
    # Край картинки тоже считается «снаружи» — рамку ищем от него
    inside = cv2.copyMakeBorder((img[:, :, 3] > 0).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    # Рамка иконки ~8 px: от края отступаем чуть больше, чтобы её не задеть
    dist = cv2.distanceTransform(inside, cv2.DIST_L2, 5)[1:-1, 1:-1]
    erase = dist > 9
    x0, y0, x1, y1 = PLAN_BOX
    erase[y0:y1, x0:x1] = False
    # Цвет фона берём из самой картинки (в палитре он чуть другой)
    fill = np.median(img[y0 + 20 : y0 + 40, x0 + 20 : x0 + 60, :3].reshape(-1, 3), axis=0)
    plate = img.copy()
    plate[erase, :3] = fill.astype(np.uint8)
    # Линия под названием упирается в рамку, там остаются «зубчики» — у рамки
    # в этих строках берём пиксели из строки ниже (борта карточки там прямые)
    ring = (dist > 6) & (dist <= 9)
    band = np.zeros_like(ring)
    band[HEADER_LINE[0] : HEADER_LINE[1]] = True
    ys, xs = np.nonzero(ring & band)
    plate[ys, xs] = img[HEADER_LINE[1] + 5, xs]
    return plate


def split_lines(mask, k):
    """Толстые линии (стены) и тонкие (перегородки, остекление)."""
    thick = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    thick = cv2.dilate(thick, cv2.getStructuringElement(cv2.MORPH_RECT, (k + 2, k + 2)))
    thick = cv2.bitwise_and(thick, mask)
    thin = cv2.bitwise_and(mask, cv2.bitwise_not(thick))
    return thick, thin


def silhouette(mask):
    """Силуэт плана без перекрытий (квартира) — выпуклая оболочка линий."""
    filled = np.zeros_like(mask)
    ys, xs = np.nonzero(mask)
    hull = cv2.convexHull(np.stack([xs, ys], axis=1).astype(np.int32))
    cv2.fillPoly(filled, [hull], 255)
    return filled


def facade_runs(body, thick, size, blank):
    """Глухие участки наружных стен: отрезки контура силуэта, за которыми стоит
    толстая стена. Возвращает [{a, b, n}] — концы и внешнюю нормаль."""
    runs = []
    contours, _ = cv2.findContours(body, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    h, w = body.shape
    for c in contours:
        poly = cv2.approxPolyDP(c, 2.5, True).reshape(-1, 2).astype(np.float64)
        for i in range(len(poly)):
            p0, p1 = poly[i], poly[(i + 1) % len(poly)]
            length = np.linalg.norm(p1 - p0)
            if length < MIN_FACADE_RUN:
                continue
            t = (p1 - p0) / length
            n = np.array([t[1], -t[0]])
            mid = (p0 + p1) / 2
            x, y = (mid + n * 4).round().astype(int)
            if 0 <= x < w and 0 <= y < h and body[y, x]:
                n = -n
            # Идём вдоль отрезка и отмечаем, где изнутри есть толстая стена
            steps = int(length // 2)
            solid = []
            for k in range(steps + 1):
                q = p0 + t * (k * length / steps)
                ok = False
                bx, by = q.round().astype(int)
                if 0 <= bx < w and 0 <= by < h and blank[by, bx]:
                    solid.append(False)
                    continue
                for depth in (2, 4, 6, 8, 10):
                    x, y = (q - n * depth).round().astype(int)
                    if 0 <= x < w and 0 <= y < h and thick[y, x]:
                        ok = True
                        break
                solid.append(ok)
            start = None
            for k, ok in enumerate(solid + [False]):
                if ok and start is None:
                    start = k
                elif not ok and start is not None:
                    # Края участка обрезаем — там углы и примыкания
                    a = p0 + t * (start * length / steps + 6)
                    b = p0 + t * ((k - 1) * length / steps - 6)
                    if np.dot(b - a, t) >= MIN_FACADE_RUN:
                        runs.append({
                            "a": to_norm([a], size)[0],
                            "b": to_norm([b], size)[0],
                            "n": [round(float(n[0]), 4), round(float(n[1]), 4)],
                        })
                    start = None
    return runs


def lifted_legs(region_mask, size):
    """Точки V-образных опор вдоль края поднятого объёма: [{p, t}]."""
    legs = []
    inner = cv2.erode(region_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    contours, _ = cv2.findContours(inner, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    for c in contours:
        pts = c.reshape(-1, 2).astype(np.float64)
        seg = np.linalg.norm(np.diff(np.vstack([pts, pts[:1]]), axis=0), axis=1)
        dist = np.concatenate([[0], np.cumsum(seg)])
        total = dist[-1]
        count = max(3, int(total // 62))
        for k in range(count):
            i = int(np.searchsorted(dist, (k + 0.5) * total / count)) % len(pts)
            q = pts[(i + 4) % len(pts)] - pts[(i - 4) % len(pts)]
            t = q / (np.linalg.norm(q) or 1)
            legs.append({"p": to_norm([pts[i]], size)[0], "t": [round(float(t[0]), 4), round(float(t[1]), 4)]})
    return legs


def main():
    palette = load_palette()
    ellipse = lambda d: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))
    for slug, cfg in PROJECTS.items():
        img = cv2.imread(str(ROOT / f"public/icons/{slug}-dark.png"), cv2.IMREAD_UNCHANGED)
        size = img.shape[1]
        ink = hex_to_bgr(palette[slug]["ink"])
        bg = hex_to_bgr(palette[slug]["bg"])
        mask = ink_mask(img, ink, bg)
        thick, thin = split_lines(mask, cfg.get("thin_kernel", THIN_KERNEL))

        slab = []
        annex = []
        wall_mask = mask
        if cfg["slab_close"]:
            body = slab_mask(mask, cfg["slab_close"], cfg.get("exclude", []))
            slab = polygons(body, size, eps=2.0, min_area=2000)
            # Стены внутри силуэта идут на все этажи, снаружи (переходы) — только первый этаж
            inside = cv2.dilate(body, ellipse(9))
            wall_mask = cv2.bitwise_and(mask, inside)
            annex = polygons(cv2.bitwise_and(mask, cv2.bitwise_not(inside)), size, eps=0.9, min_area=12)
        else:
            body = silhouette(mask)

        # Тонкие линии на внешнем контуре — остекление (окна, лоджии), внутри — перегородки
        rim = cv2.subtract(cv2.dilate(body, ellipse(9)), cv2.erode(body, ellipse(cfg.get("rim", 9))))
        glass_mask = cv2.bitwise_and(cv2.bitwise_and(thin, rim), wall_mask)
        glass_mask = cv2.dilate(glass_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)))
        wall_mask = cv2.bitwise_and(wall_mask, cv2.bitwise_not(glass_mask))
        glazing = polygons(glass_mask, size, eps=0.9, min_area=10)
        walls = polygons(wall_mask, size, eps=0.9, min_area=12)

        parapet = []
        if cfg["roof"]:
            ring = cv2.subtract(body, cv2.erode(body, ellipse(9)))
            parapet = polygons(ring, size, eps=1.2, min_area=50)

        canopy = None
        if cfg.get("canopy"):
            c = cfg["canopy"]
            cap = cv2.morphologyEx(cv2.erode(body, ellipse(2 * c["inset"] + 1)), cv2.MORPH_OPEN, ellipse(15))
            posts = []
            contours, _ = cv2.findContours(cv2.erode(cap, ellipse(13)), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            for cnt in contours:
                posts += to_norm(cv2.approxPolyDP(cnt, 12, True).reshape(-1, 2), size)
            frame = cv2.subtract(cap, cv2.erode(cap, ellipse(2 * c["frame"] + 1)))
            canopy = {"height": c["h"], "slab": polygons(frame, size, eps=2.0, min_area=500), "posts": posts}

        lifted = None
        if cfg.get("lifted"):
            region = np.zeros_like(mask)
            cv2.fillPoly(region, [np.array(cfg["lifted"], dtype=np.int32)], 255)
            lifted = {
                "region": to_norm(cfg["lifted"], size),
                "wallsGround": polygons(cv2.bitwise_and(wall_mask, cv2.bitwise_not(region)), size, eps=0.9, min_area=12),
                "legs": lifted_legs(cv2.bitwise_and(body, region), size),
            }

        windows = None
        facades = []
        if cfg.get("windows"):
            w = cfg["windows"]
            windows = {**w, "spacing": round(w["spacing"] / size, 5)}
            blank = np.zeros_like(mask)
            for poly in cfg.get("blank", []):
                cv2.fillPoly(blank, [np.array(poly, dtype=np.int32)], 255)
            facades = facade_runs(body, cv2.bitwise_and(thick, wall_mask), size, blank)

        ys, xs = np.nonzero(mask)
        bounds = to_norm([(xs.min(), ys.min()), (xs.max(), ys.max())], size)

        model = {
            "floors": cfg["floors"],
            "floorHeight": cfg["floor_h"],
            "roof": cfg["roof"],
            "bounds": bounds,
            "walls": walls,
            "annex": annex,
            "slab": slab,
            "glazing": glazing,
            "rail": cfg.get("rail", 0.32),
            "parapet": parapet,
            "facades": facades,
            "windows": windows,
            "canopy": canopy,
            "lifted": lifted,
        }
        out = ROOT / f"public/projects/{slug}/model.json"
        if not cfg.get("detailed"):
            out.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
        cv2.imwrite(str(out.with_name("plate.png")), clean_plate(img))
        verts = sum(len(p["outer"]) + sum(len(h) for h in p["holes"]) for p in walls)
        print(
            f"{slug}: {len(walls)} стен ({verts} вершин), {len(glazing)} остеклений, "
            f"{len(facades)} участков фасада с окнами, {len(annex)} пристроек, "
            f"{len(slab)} перекрытий" + (" (детальный макет — make-school-model.mjs)" if cfg.get("detailed") else f", {out.stat().st_size // 1024} КБ")
        )

        # Контрольная картинка: стены (красные), остекление (синее), участки фасада
        # с окнами (лиловые), силуэт (жёлтый), опоры и стойки навеса (точки)
        dbg = img[:, :, :3].copy()

        def draw(ring, color, width):
            cv2.polylines(dbg, [((np.array(ring) + 0.5) * size).astype(np.int32)], True, color, width)

        def dot(pt, color):
            cv2.circle(dbg, tuple(((np.array(pt) + 0.5) * size).astype(int)), 5, color, -1)

        for p in slab:
            draw(p["outer"], (0, 255, 255), 2)
        for p in annex + walls:
            for ring in [p["outer"], *p["holes"]]:
                draw(ring, (0, 255, 0) if p in annex else (0, 0, 255), 1)
        for p in glazing:
            draw(p["outer"], (255, 128, 0), 2)
        for f in facades:
            n = np.array(f["n"]) * 6
            a = ((np.array(f["a"]) + 0.5) * size + n).astype(int)
            b = ((np.array(f["b"]) + 0.5) * size + n).astype(int)
            cv2.line(dbg, tuple(a), tuple(b), (255, 0, 255), 3)
        if lifted:
            draw(lifted["region"], (255, 255, 0), 1)
            for leg in lifted["legs"]:
                dot(leg["p"], (255, 255, 0))
        if canopy:
            for q in canopy["posts"]:
                dot(q, (255, 255, 255))
        debug_dir = ROOT / ".model-debug"
        debug_dir.mkdir(exist_ok=True)
        cv2.imwrite(str(debug_dir / f"{slug}.png"), dbg)


if __name__ == "__main__":
    main()
