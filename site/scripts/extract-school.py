"""
Извлекает план музыкальной школы для детального 3D-макета.

Источники:
- альбом АР `assets/PDF музыкальная школа/*.pdf`, лист 08 «План размещения
  осветительного оборудования» — растр Revit ~550 dpi, стены залиты серым:
  из него берутся стены 1-го этажа, проёмы, мебель и ряды кресел зала;
- иконка `public/icons/school-dark.png` — на ней план 2-го этажа (его листа
  в альбоме нет): перегородки верхних этажей, силуэт здания, поднятый круглый
  объём и его V-образные опоры.

План из PDF совмещается с иконкой подбором поворота, масштаба и сдвига,
чтобы 3D-здание вставало точно на линии карточки.

Результат — `scripts/data/school-plan.json`, всё в метрах: x — на восток от
оси 1, z — на юг от оси З. Там же `transform` — перевод метров в координаты
карточки (как в model.json). Его читает scripts/make-school-model.mjs.

Запуск: python scripts/extract-school.py   (нужны numpy, opencv-python-headless, pymupdf)
"""
import importlib.util
import json
from pathlib import Path

import cv2
import numpy as np
import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDF = next((ROOT.parent / "assets/PDF музыкальная школа").glob("*.pdf"))
OUT = ROOT / "scripts/data/school-plan.json"
DEBUG = ROOT / ".model-debug"

# make-models.py — те же функции разбора иконки
_spec = importlib.util.spec_from_file_location("make_models", ROOT / "scripts/make-models.py")
mm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mm)

PAGE = 7  # лист 08 (нумерация страниц PDF с нуля)
# Область плана на листе, pt
CROP = (702, 144, 1644, 822)

# Оси (м): x — от оси 1, z — от оси З (по размерным цепочкам листа 02)
AX = {"1": 0.0, "2": 2.48, "3": 3.56, "4": 6.84, "5": 23.53, "6": 26.47, "7": 38.13, "8": 53.07, "9": 56.95}
AZ = {"З": 0.0, "Ж": 7.04, "Е": 9.71, "Д": 13.59, "Г": 16.09, "В": 19.51, "А": 37.85}

# Растр в метрах для операций над областями
GRID = 20  # px/м
GX0, GZ0, GW, GH = -8.0, -6.0, 76.0, 56.0


def stitch(doc, pno):
    """Склеивает растровые плитки страницы (без векторных надписей)."""
    page = doc[pno]
    infos = [i for i in page.get_image_info(xrefs=True) if i["xref"]]
    sx = max(i["width"] / (i["bbox"][2] - i["bbox"][0]) for i in infos)
    W, H = int(page.rect.width * sx) + 2, int(page.rect.height * sx) + 2
    canvas = np.full((H, W, 3), 255, np.uint8)
    for info in infos:
        pix = pymupdf.Pixmap(doc, info["xref"])
        if pix.n != 3 or pix.alpha:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
        x0, y0, x1, y1 = info["bbox"]
        X, Y = int(round(x0 * sx)), int(round(y0 * sx))
        w, h = int(round((x1 - x0) * sx)), int(round((y1 - y0) * sx))
        if (w, h) != (a.shape[1], a.shape[0]):
            a = cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA)
        hh, ww = min(h, H - Y), min(w, W - X)
        canvas[Y : Y + hh, X : X + ww] = a[:hh, :ww]
    return canvas[:, :, ::-1].copy(), sx


def axis_extent(page):
    """Габаритные размерные линии: 1–9 по горизонтали и З–А по вертикали, pt."""
    hor = ver = None
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] != "l" or not d.get("color") or d["color"][1] < 0.5 or d["color"][0] < 0.8:
                continue
            a, b = it[1], it[2]
            if abs(a.y - b.y) < 0.1 and abs(a.x - b.x) > 700:
                hor = (min(a.x, b.x), max(a.x, b.x))
            if abs(a.x - b.x) < 0.1 and abs(a.y - b.y) > 500:
                ver = (min(a.y, b.y), max(a.y, b.y))
    return hor, ver


def ellipse(d):
    d = max(1, int(round(d)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


def wall_mask(img):
    """Стены: серая заливка вместе с чёрным контуром и толстые чёрные перегородки."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.int32)
    sat = img.max(axis=2).astype(np.int32) - img.min(axis=2)
    grey = ((g >= 196) & (g <= 228) & (sat < 10)).astype(np.uint8) * 255
    black = ((g < 90) & (sat < 30)).astype(np.uint8) * 255
    grey = cv2.morphologyEx(grey, cv2.MORPH_OPEN, ellipse(7))
    solid = cv2.morphologyEx(black, cv2.MORPH_OPEN, ellipse(9))
    wall = cv2.bitwise_or(cv2.bitwise_and(cv2.bitwise_or(grey, black), cv2.dilate(grey, ellipse(9))), solid)
    wall = cv2.morphologyEx(wall, cv2.MORPH_OPEN, ellipse(7))
    return cv2.morphologyEx(wall, cv2.MORPH_CLOSE, ellipse(5))


def drop_small(mask, min_px):
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    keep = np.zeros(n, bool)
    keep[1:] = st[1:, cv2.CC_STAT_AREA] >= min_px
    return (keep[lab] * 255).astype(np.uint8)


def register(wall, ink):
    """Подбор подобия план → иконка по расстоянию до линий иконки."""
    small = cv2.resize(wall, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    ys, xs = np.nonzero(small > 100)
    P = (np.stack([xs, ys], 1).astype(np.float64) * 4)[::3]
    dt = cv2.distanceTransform(255 - ink, cv2.DIST_L2, 5)
    H, W = dt.shape

    def cost(q):
        s, th, tx, ty = q
        c, sn = np.cos(th), np.sin(th)
        X = s * (c * P[:, 0] - sn * P[:, 1]) + tx
        Y = s * (sn * P[:, 0] + c * P[:, 1]) + ty
        xi = np.clip(X.round().astype(int), 0, W - 1)
        yi = np.clip(Y.round().astype(int), 0, H - 1)
        return np.minimum(dt[yi, xi], 15).mean()

    # Начальное приближение — по габаритам северного блока
    iy, ix = np.nonzero(ink[:, :940])
    wy, wx = np.nonzero(wall)
    s0 = (ix.max() - ix.min()) / (wx.max() - wx.min())
    q = np.array([s0, 0.0, ix.min() - wx.min() * s0, iy.min() - wy.min() * s0])
    best = cost(q)
    steps = np.array([0.002, 0.003, 4.0, 4.0])
    while steps[2] >= 0.02:
        improved = False
        for i in range(4):
            for sgn in (1, -1):
                t = q.copy()
                t[i] += sgn * steps[i]
                c = cost(t)
                if c < best:
                    best, q, improved = c, t, True
        if not improved:
            steps /= 2
    return q, best


class Frame:
    """Переводы между пикселями плана, метрами, пикселями иконки и сеткой в метрах."""

    def __init__(self, ox, oz, px_m, reg, icon_size):
        self.ox, self.oz, self.px = ox, oz, px_m
        s, th, tx, ty = reg
        self.M = np.array([[s * np.cos(th), -s * np.sin(th), tx], [s * np.sin(th), s * np.cos(th), ty]])
        self.size = icon_size
        # метры → пиксели иконки
        A = self.M[:, :2] * px_m
        b = self.M[:, :2] @ np.array([ox, oz]) + self.M[:, 2]
        self.m2i = np.hstack([A, b[:, None]])
        self.i2m = cv2.invertAffineTransform(self.m2i)

    def plan_to_m(self, pts):
        pts = np.asarray(pts, np.float64)
        return np.stack([(pts[:, 0] - self.ox) / self.px, (pts[:, 1] - self.oz) / self.px], 1)

    def m_to_grid(self, pts):
        pts = np.asarray(pts, np.float64)
        return np.stack([(pts[:, 0] - GX0) * GRID, (pts[:, 1] - GZ0) * GRID], 1)

    def grid_to_m(self, pts):
        pts = np.asarray(pts, np.float64)
        return np.stack([pts[:, 0] / GRID + GX0, pts[:, 1] / GRID + GZ0], 1)

    def plan_to_grid_M(self):
        """Аффинное преобразование растра плана в сетку метров."""
        k = GRID / self.px
        return np.array([[k, 0, -self.ox * k - GX0 * GRID], [0, k, -self.oz * k - GZ0 * GRID]])

    def icon_to_grid_M(self):
        A = np.vstack([self.i2m, [0, 0, 1]])
        G = np.array([[GRID, 0, -GX0 * GRID], [0, GRID, -GZ0 * GRID], [0, 0, 1]])
        return (G @ A)[:2]

    def transform(self):
        """Метры → координаты карточки: n = k·R(θ)·(x, z) + (ox, oz)."""
        A = self.m2i[:, :2] / self.size
        k = float(np.sqrt(abs(np.linalg.det(A))))
        theta = float(np.arctan2(A[1, 0], A[0, 0]))
        o = self.m2i[:, 2] / self.size - 0.5
        return {"k": round(k, 7), "theta": round(theta, 6), "ox": round(float(o[0]), 6), "oz": round(float(o[1]), 6)}


def rnd(pts, nd=3):
    return [[round(float(x), nd), round(float(z), nd)] for x, z in pts]


def grid_polys(mask, fr, eps_m=0.05, min_m2=0.3):
    """Контуры (с отверстиями) маски-сетки → полигоны в метрах."""
    out = []
    for p in mm.polygons(mask, 1, eps=eps_m * GRID, min_area=min_m2 * GRID * GRID):
        # mm.polygons нормирует на size-0.5; size=1 → координаты в px сетки со сдвигом 0.5
        conv = lambda r: rnd(fr.grid_to_m(np.array(r) + 0.5))
        out.append({"outer": conv(p["outer"]), "holes": [conv(h) for h in p["holes"]]})
    return out


def plan_polys(mask, fr, eps_px, min_px):
    out = []
    for p in mm.polygons(mask, 1, eps=eps_px, min_area=min_px):
        conv = lambda r: rnd(fr.plan_to_m(np.array(r) + 0.5))
        out.append({"outer": conv(p["outer"]), "holes": [conv(h) for h in p["holes"]]})
    return out


def rect_grid(fr, x0, z0, x1, z1):
    """Прямоугольник в метрах → маска сетки."""
    m = np.zeros((int(GH * GRID), int(GW * GRID)), np.uint8)
    a = fr.m_to_grid([[x0, z0], [x1, z1]]).round().astype(int)
    cv2.rectangle(m, tuple(a[0]), tuple(a[1]), 255, -1)
    return m


def poly_grid(fr, pts):
    m = np.zeros((int(GH * GRID), int(GW * GRID)), np.uint8)
    cv2.fillPoly(m, [fr.m_to_grid(pts).round().astype(np.int32)], 255)
    return m


def directional_close(mask, length):
    """Замыкание разрывов вдоль строк и столбцов. Поле вокруг — чтобы у края
    листа замыкание не «прилипало» к границе."""
    pad = length + 2
    m = cv2.copyMakeBorder(mask, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    h = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1)))
    v = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, length)))
    return cv2.bitwise_or(h, v)[pad:-pad, pad:-pad]


def openings(wall, barrier, fr):
    """Проёмы: разрывы в прямых стенах. Наружные (к улице) — окна и входы,
    внутренние — двери (над ними перемычки)."""
    px = fr.px
    long_c = directional_close(wall, int(5.0 * px))
    short_c = directional_close(wall, int(2.3 * px))
    # «Улица» — всё, куда можно пройти от края листа, не пересекая стен и витражей
    solid = cv2.bitwise_or(long_c, barrier)
    free = cv2.bitwise_not(solid)
    h, w = free.shape
    ff = np.zeros((h + 2, w + 2), np.uint8)
    outside = free.copy()
    cv2.floodFill(outside, ff, (0, 0), 128)
    outside = (outside == 128).astype(np.uint8) * 255
    near_out = cv2.dilate(outside, ellipse(9))

    result = []
    for kind, closed in (("outer", long_c), ("inner", short_c)):
        gaps = cv2.subtract(closed, wall)
        gaps = cv2.morphologyEx(gaps, cv2.MORPH_OPEN, ellipse(9))
        n, lab, st, _ = cv2.connectedComponentsWithStats(gaps)
        for i in range(1, n):
            x, y, ww, hh, area = st[i]
            if area < 0.05 * px * px:
                continue
            comp = (lab == i).astype(np.uint8) * 255
            touches = cv2.countNonZero(cv2.bitwise_and(comp, near_out)) > 0
            if (kind == "outer") != touches:
                continue
            span = max(ww, hh) / px
            if span < 0.6 or (kind == "inner" and span > 2.4):
                continue
            rect = cv2.minAreaRect(cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0][0])
            # Проём — узкая полоса толщиной в стену; залитые замыканием комнаты отбрасываем
            (rw, rh) = rect[1]
            if min(rw, rh) > 0.9 * px or area < 0.6 * rw * rh:
                continue
            box = rnd(fr.plan_to_m(cv2.boxPoints(rect)))
            result.append({"kind": kind, "width": round(span, 2), "poly": box})
    return result, outside


def furniture(img, wall, fr, zones_keep):
    """Замкнутые серые контуры мебели (столы, шкафы, рояль)."""
    px = fr.px
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sat = img.max(axis=2).astype(np.int32) - img.min(axis=2)
    line = ((g < 200) & (g > 60) & (sat < 12)).astype(np.uint8) * 255
    line[cv2.dilate(wall, ellipse(9)) > 0] = 0
    cnts, hier = cv2.findContours(line, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    items = []
    for i, c in enumerate(cnts):
        if hier[0][i][3] == -1:
            continue  # нужны внутренние контуры — замкнутые области
        a = cv2.contourArea(c) / px / px
        if not 0.25 < a < 7:
            continue
        m = cv2.moments(c)
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        cm = fr.plan_to_m([[cx, cy]])[0]
        zone = next((z for z, test in zones_keep.items() if test(cm[0], cm[1])), None)
        if not zone:
            continue
        poly = cv2.approxPolyDP(c, 2.5, True).reshape(-1, 2)
        if len(poly) < 3:
            continue
        items.append({"zone": zone, "area": round(a, 2), "poly": rnd(fr.plan_to_m(poly))})
    return items


def seat_rows(img, wall, fr, hall):
    """Ряды кресел зала: квадраты ~0.6 м; ряды и шаг — по найденным креслам,
    края ряда — по серым контурам в полосе ряда."""
    px = fr.px
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sat = img.max(axis=2).astype(np.int32) - img.min(axis=2)
    line = ((g < 215) & (g > 60) & (sat < 12)).astype(np.uint8) * 255
    line[cv2.dilate(wall, ellipse(9)) > 0] = 0
    x0, z0, x1, z1 = hall
    cnts, hier = cv2.findContours(line, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    seats = []
    for i, c in enumerate(cnts):
        if hier[0][i][3] == -1:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if not (0.4 < w / px < 0.8 and 0.4 < h / px < 0.8):
            continue
        cm = fr.plan_to_m([[x + w / 2, y + h / 2]])[0]
        if x0 < cm[0] < x1 and z0 < cm[1] < z1:
            seats.append((cm[0], cm[1], w / px))
    seats.sort(key=lambda s: s[1])
    rows = []
    for s in seats:
        if rows and abs(rows[-1][-1][1] - s[1]) < 0.3:
            rows[-1].append(s)
        else:
            rows.append([s])
    pitch = float(np.median([b[0] - a[0] for r in rows for a, b in zip(sorted(r), sorted(r)[1:]) if b[0] - a[0] < 1.0]))
    size = float(np.median([s[2] for s in seats]))
    out = []
    for r in rows:
        if len(r) < 3:
            continue
        z = float(np.median([s[1] for s in r]))
        xs = sorted(s[0] for s in r)
        # Края ряда: серые контуры в полосе ряда
        yy0 = int(fr.oz + (z - size / 2) * px)
        yy1 = int(fr.oz + (z + size / 2) * px)
        xx0 = int(fr.ox + x0 * px)
        xx1 = int(fr.ox + x1 * px)
        cols = np.nonzero(line[yy0:yy1, xx0:xx1].sum(axis=0) > 255 * size * px * 0.5)[0]
        lo, hi = xs[0], xs[-1]
        if len(cols):
            lo = min(lo, (xx0 + cols[0] - fr.ox) / px + size / 2)
            hi = max(hi, (xx0 + cols[-1] - fr.ox) / px - size / 2)
        # Сетка от первого найденного кресла
        k0 = int(np.floor((lo - xs[0]) / pitch + 0.3))
        k1 = int(np.ceil((hi - xs[0]) / pitch - 0.3))
        out.append({"z": round(z, 3), "x": [round(xs[0] + k * pitch, 3) for k in range(k0, k1 + 1)]})
    return {"pitch": round(pitch, 3), "size": round(size, 3), "rows": out}


def boundary_samples(mask_grid, fr, step, test):
    """Точки внешнего контура маски с шагом step (м) и внешней нормалью —
    для плавников фасада. test(x, z) отбирает нужный участок."""
    cnts, _ = cv2.findContours(mask_grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cnts:
        pts = fr.grid_to_m(c.reshape(-1, 2).astype(np.float64))
        seg = np.linalg.norm(np.diff(np.vstack([pts, pts[:1]]), axis=0), axis=1)
        dist = np.concatenate([[0], np.cumsum(seg)])
        total = dist[-1]
        if total < 5:
            continue
        n = int(total // step)
        ok_prev = False
        for k in range(n):
            d = (k + 0.5) * total / n
            i = int(np.searchsorted(dist, d)) % len(pts)
            p = pts[i]
            q = pts[(i + 6) % len(pts)] - pts[(i - 6) % len(pts)]
            t = q / (np.linalg.norm(q) or 1)
            # CHAIN внешнего контура идёт по часовой в координатах картинки → нормаль наружу
            nrm = np.array([t[1], -t[0]])
            probe = fr.m_to_grid([p + nrm * 0.4])[0].round().astype(int)
            if mask_grid[probe[1], probe[0]]:
                nrm = -nrm
            if test(p[0], p[1]):
                out.append({"p": rnd([p])[0], "n": rnd([nrm], 4)[0]})
    return out


def main():
    doc = pymupdf.open(PDF)
    page = doc[PAGE]
    raster, sx = stitch(doc, PAGE)
    x0, y0, x1, y1 = (int(v * sx) for v in CROP)
    img = raster[y0:y1, x0:x1]
    (ax1, ax9), (azZ, azA) = axis_extent(page)
    ox, oz = ax1 * sx - x0, azZ * sx - y0
    px_m = ((ax9 - ax1) * sx / AX["9"] + (azA - azZ) * sx / AZ["А"]) / 2

    # Иконка: линии, силуэт, поднятый объём
    palette = mm.load_palette()["school"]
    icon = cv2.imread(str(ROOT / "public/icons/school-dark.png"), cv2.IMREAD_UNCHANGED)
    icon_size = icon.shape[1]
    ink = mm.ink_mask(icon, mm.hex_to_bgr(palette["ink"]), mm.hex_to_bgr(palette["bg"]))
    cfg = mm.PROJECTS["school"]

    wall = drop_small(wall_mask(img), int(0.35 * px_m * px_m))
    reg, err = register(wall, ink)
    fr = Frame(ox, oz, px_m, reg, icon_size)

    G_shape = (int(GH * GRID), int(GW * GRID))
    to_grid_icon = lambda m, interp=cv2.INTER_NEAREST: cv2.warpAffine(m, fr.icon_to_grid_M(), G_shape[::-1], flags=interp)
    to_grid_plan = lambda m: cv2.warpAffine(m, fr.plan_to_grid_M(), G_shape[::-1], flags=cv2.INTER_AREA)

    # Силуэт по иконке (вместе с атриумом и круглым объёмом)
    body_icon = mm.slab_mask(ink, cfg["slab_close"], [])
    body = to_grid_icon(body_icon)
    lifted_icon = np.zeros_like(ink)
    cv2.fillPoly(lifted_icon, [np.array(cfg["lifted"], np.int32)], 255)
    round_g = cv2.bitwise_and(to_grid_icon(lifted_icon), body)
    round_g = cv2.morphologyEx(round_g, cv2.MORPH_OPEN, ellipse(GRID * 0.8))
    round_g = drop_small(round_g, GRID * GRID * 20)
    # Корпус круглого объёма — без «гребёнки» плавников, и кольцо его стен
    # На видах (титул, аксонометрии) объём — чистая «D»-форма: берём выпуклую оболочку
    hull_pts = cv2.convexHull(cv2.findNonZero(round_g))
    round_g = np.zeros_like(round_g)
    cv2.fillPoly(round_g, [hull_pts], 255)
    round_core = cv2.erode(round_g, ellipse(GRID * 1.0))
    round_ring = cv2.subtract(round_core, cv2.erode(round_core, ellipse(GRID * 0.8)))

    # Зоны (м)
    in_north = lambda x, z: z < AZ["Г"] - 0.2
    in_hall = lambda x, z: AX["4"] + 0.3 < x < AX["5"] - 0.3 and z > AZ["В"] + 0.3
    in_stage = lambda x, z: in_hall(x, z) and z < 25.0

    # Преграда для «улицы»: косой витраж, передняя стенка тамбура 28 и стык с осью 9.
    # Точки сняты с листа 08 (px плана).
    diag = np.array([[3208, 3905], [5178, 3408], [5570, 3318], [5760, 3272], [6260, 3150], [6420, 3110]], np.int32)
    # Витраж по оси 9 между концом глухой стены и тамбуром 28
    east_glass = np.array([[6420, 3110], [6400, 1990]], np.int32)
    barrier = np.zeros_like(wall)
    cv2.polylines(barrier, [diag, east_glass], False, 255, 25)
    ops, outside_plan = openings(wall, barrier, fr)

    # Косой витраж, витраж по оси 9 и тамбур 28 строятся отдельно (make-school-model):
    # стойки витража и проёмы у них из плана не берём
    glass_band = np.zeros_like(wall)
    start = diag[0] + (diag[1] - diag[0]) * (1.2 * px_m / np.linalg.norm(diag[1] - diag[0]))
    cv2.polylines(glass_band, [np.vstack([start.astype(np.int32), diag[1:]]), east_glass], False, 255, int(1.6 * px_m))
    wall = cv2.subtract(wall, glass_band)
    ops = [o for o in ops if not glass_band[
        min(int(fr.oz + np.mean([q[1] for q in o["poly"]]) * px_m), wall.shape[0] - 1),
        min(int(fr.ox + np.mean([q[0] for q in o["poly"]]) * px_m), wall.shape[1] - 1),
    ]]

    # Наружные стены 1-го этажа — полоса стен у «улицы» (с облицовкой ~0.8 м)
    outer_wall = cv2.bitwise_and(wall, cv2.dilate(outside_plan, ellipse(0.8 * px_m * 2)))
    outer_wall = drop_small(outer_wall, int(0.05 * px_m * px_m))
    # Сглаживаем «точки» облицовки по краю, чтобы контур не был зубчатым
    outer_wall = cv2.morphologyEx(outer_wall, cv2.MORPH_CLOSE, ellipse(15))
    outer_wall = cv2.bitwise_and(cv2.morphologyEx(outer_wall, cv2.MORPH_OPEN, ellipse(11)), cv2.dilate(wall, ellipse(15)))
    inner_wall = cv2.subtract(wall, outer_wall)
    # Стены зала на всю высоту: длинные прямые участки внутренних стен в блоке зала
    hall_zone = np.zeros_like(wall)
    zx0, zz0 = int(fr.ox + 2.4 * px_m), int(fr.oz + (AZ["В"] - 0.4) * px_m)
    zx1 = int(fr.ox + (AX["6"] + 0.7) * px_m)
    hall_zone[zz0:, zx0:zx1] = 255
    in_zone = cv2.bitwise_and(inner_wall, hall_zone)
    runs = cv2.bitwise_or(
        cv2.morphologyEx(in_zone, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, int(5 * px_m)))),
        cv2.morphologyEx(in_zone, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (int(6 * px_m), 1))),
    )
    hall_wall = cv2.bitwise_and(cv2.dilate(runs, ellipse(7)), in_zone)
    inner_wall = cv2.subtract(inner_wall, hall_wall)
    walls_outer = plan_polys(outer_wall, fr, eps_px=6.0, min_px=int(0.05 * px_m * px_m))
    walls_inner = plan_polys(drop_small(inner_wall, int(0.03 * px_m * px_m)), fr, eps_px=1.6, min_px=int(0.03 * px_m * px_m))
    walls_hall = plan_polys(hall_wall, fr, eps_px=1.6, min_px=int(0.05 * px_m * px_m))

    # Пол зала: помещение вокруг центра зала
    free_room = cv2.bitwise_not(cv2.dilate(wall, ellipse(3)))
    ffm = np.zeros((free_room.shape[0] + 2, free_room.shape[1] + 2), np.uint8)
    seed = (int(fr.ox + 15.2 * px_m), int(fr.oz + 31.0 * px_m))
    cv2.floodFill(free_room, ffm, seed, 128)
    hall_floor = cv2.morphologyEx((free_room == 128).astype(np.uint8) * 255, cv2.MORPH_OPEN, ellipse(25))

    # Силуэт 1-го этажа по PDF: всё, что не «улица»
    inside_plan = cv2.bitwise_not(outside_plan)
    inside_plan = drop_small(cv2.morphologyEx(inside_plan, cv2.MORPH_OPEN, ellipse(15)), int(50 * px_m * px_m))
    footprint = to_grid_plan(inside_plan)
    footprint = (footprint > 127).astype(np.uint8) * 255

    # Плавники зала: по наружному контуру зала (боковые стены и полукруг)
    hall_fins = boundary_samples(
        footprint, fr, 0.92,
        lambda x, z: x < AX["6"] + 0.6 and z > AZ["В"] + 0.6 and not (x > AX["6"] - 0.2 and z < 34),
    )
    # Плавники круглого объёма: по дуге, без прямой южной грани
    # Плавники круглого объёма — по всему контуру (у окон южной грани их обрезает make-school-model)
    round_fins = boundary_samples(round_core, fr, 0.92, lambda x, z: True)

    # Перекрытия этажей: северный блок, коридор-галерея, боковые полосы зала
    slab_zone = cv2.bitwise_or(rect_grid(fr, -3, -3, 60, AZ["В"]), rect_grid(fr, -3, AZ["В"], AX["4"] - 0.1, 50))
    slab_zone = cv2.bitwise_or(slab_zone, rect_grid(fr, AX["5"] + 0.1, AZ["В"], AX["6"] + 0.4, 50))
    slab_mid = cv2.subtract(cv2.bitwise_and(body, slab_zone), cv2.dilate(round_g, ellipse(GRID * 0.3)))
    inside_walls = cv2.erode(footprint, ellipse(GRID * 0.3))
    slab_mid = cv2.bitwise_and(slab_mid, inside_walls)
    # Атриум: к югу от галереи перекрытий нет
    slab_mid = cv2.subtract(slab_mid, rect_grid(fr, AX["6"] + 0.4, AZ["Г"] + 3.4, 60, 50))

    # Кровля: весь силуэт без круглого объёма. Над атриумом (с галереей) кровля —
    # отдельная ступень выше (фасад 1: +18.2 против +17.6), в ней фонари
    roof = cv2.subtract(cv2.bitwise_and(body, inside_walls), cv2.dilate(round_g, ellipse(GRID * 0.2)))
    atrium_zone = rect_grid(fr, AX["6"] + 0.2, AZ["Г"] + 0.25, 70, 50)
    roof_high = cv2.bitwise_and(roof, atrium_zone)
    # Плита не должна выступать за косую и восточную стены атриума (они стоят внутрь от линий витражей)
    dm = fr.plan_to_m(diag[:2].astype(np.float64))
    dd = (dm[1] - dm[0]) / np.linalg.norm(dm[1] - dm[0])
    north = np.array([dd[1], -dd[0]])
    a0 = dm[0] + north * 0.05
    south_cut = [a0 - dd * 30, a0 + dd * 60, a0 + dd * 60 - north * 30, a0 - dd * 30 - north * 30]
    roof_high = cv2.subtract(roof_high, poly_grid(fr, south_cut))
    eg = fr.plan_to_m(east_glass.astype(np.float64))
    ex = min(eg[:, 0]) - 0.02
    roof_high = cv2.subtract(roof_high, rect_grid(fr, ex, AZ["Г"] + 0.3, 70, 50))
    roof_low = cv2.subtract(roof, atrium_zone)
    skylights = []
    # «Пиксельный» рисунок фонарей по титулу и взрыв-схеме: клетки 1.8 м
    pattern = [
        "..#......#.....",
        ".###..#.###..#.",
        "..#..##..#..###",
        "#.##..#.##....#",
        "..#......#..#..",
        ".##.#...###....",
        "..#.......#..#.",
    ]
    cell, sx0, sz0 = 1.8, 28.2, AZ["Г"] + 0.9
    roof_safe = cv2.erode(cv2.subtract(roof_high, cv2.dilate(round_g, ellipse(GRID * 1.5))), ellipse(GRID * 2.0))
    for r, row in enumerate(pattern):
        for c, ch in enumerate(row):
            if ch != "#":
                continue
            xa, za = sx0 + c * cell, sz0 + r * cell
            # Только клетки целиком над атриумом, с запасом от витража и круглого объёма
            cellm = rect_grid(fr, xa, za, xa + cell, za + cell)
            if cv2.countNonZero(cv2.subtract(cellm, roof_safe)):
                continue
            box_m = [xa + 0.12, za + 0.12, xa + cell - 0.12, za + cell - 0.12]
            skylights.append([round(v, 2) for v in box_m])
            roof_high = cv2.subtract(roof_high, rect_grid(fr, *box_m))

    # Пол-цоколь под зданием — сглаженный силуэт (без «зубцов» иконки)
    plate = cv2.morphologyEx(cv2.bitwise_or(body, round_g), cv2.MORPH_CLOSE, ellipse(GRID * 1.5))
    plate = cv2.morphologyEx(plate, cv2.MORPH_OPEN, ellipse(GRID * 1.5))

    # Верхние этажи: перегородки по иконке (внутри силуэта, без контура и круглого объёма)
    ink_g = to_grid_icon(ink, cv2.INTER_LINEAR)
    ink_g = (ink_g > 110).astype(np.uint8) * 255
    upper = cv2.bitwise_and(ink_g, cv2.erode(body, ellipse(GRID * 1.3)))
    upper = cv2.subtract(upper, cv2.dilate(round_g, ellipse(GRID * 1.0)))
    # В самом зале и в атриуме стен нет
    upper = cv2.subtract(upper, rect_grid(fr, AX["4"] + 0.5, AZ["В"] + 0.6, AX["5"] - 0.5, 50))
    upper = cv2.subtract(upper, rect_grid(fr, AX["6"] + 0.4, AZ["Г"] + 0.6, 60, 50))
    upper = drop_small(upper, int(GRID * GRID * 0.3))

    # V-опоры под круглым объёмом (по иконке)
    legs = mm.lifted_legs(cv2.bitwise_and(body_icon, lifted_icon), icon_size)
    legs_m = []
    for leg in legs:
        p = (np.array(leg["p"]) + 0.5) * icon_size
        q = fr.i2m @ np.array([p[0], p[1], 1.0])
        t = fr.i2m[:, :2] @ np.array(leg["t"])
        t = t / (np.linalg.norm(t) or 1)
        legs_m.append({"p": rnd([q])[0], "t": rnd([t], 4)[0]})

    # Мебель и кресла
    furn = furniture(img, wall, fr, {"north": in_north, "stage": in_stage})
    hall = (AX["4"] + 0.6, 25.5, AX["5"] - 0.6, 44.0)
    seats = seat_rows(img, wall, fr, hall)

    # Грани фасадов (м) — по силуэту 1-го этажа
    zs = np.arange(footprint.shape[0]) / GRID + GZ0
    xs = np.arange(footprint.shape[1]) / GRID + GX0
    col = lambda x: np.nonzero(footprint[:, int((x - GX0) * GRID)])[0]
    rowm = lambda z: np.nonzero(footprint[int((z - GZ0) * GRID), :])[0]
    faces = {
        "north": float(zs[col(30.0)[0]]),
        "east": float(xs[rowm(8.0)[-1]]) + 1 / GRID,
        "west": float(xs[rowm(3.0)[0]]),
        "westNotch": float(xs[rowm(12.0)[0]]),
    }

    diag_m = rnd(fr.plan_to_m(diag))
    room28 = rnd(fr.plan_to_m(np.array([[697, 95], [985, 38], [1020, 180], [855, 230], [665, 268]]) * 3 + [3200, 2600]))

    data = {
        "source": PDF.name,
        "transform": fr.transform(),
        "registration": {"error_px": round(float(err), 3), "px_per_m": round(px_m, 3)},
        "axes": {"x": AX, "z": AZ},
        "faces": {k: round(v, 3) for k, v in faces.items()},
        "footprint": grid_polys(footprint, fr, 0.05, 20),
        "body": grid_polys(body, fr, 0.08, 20),
        "round": grid_polys(round_g, fr, 0.06, 5),
        "roundCore": grid_polys(round_core, fr, 0.06, 5),
        "roundRing": grid_polys(round_ring, fr, 0.04, 1),
        "slabMid": grid_polys(slab_mid, fr, 0.06, 1),
        "roofLow": grid_polys(roof_low, fr, 0.06, 1),
        "roofHigh": grid_polys(roof_high, fr, 0.06, 1),
        "plate": grid_polys(plate, fr, 0.12, 20),
        "skylights": skylights,
        "wallsOuter": walls_outer,
        "wallsInner": walls_inner,
        "wallsHall": walls_hall,
        "hallFloor": plan_polys(hall_floor, fr, eps_px=3, min_px=int(20 * px_m * px_m)),
        "wallsUpper": grid_polys(upper, fr, 0.04, 0.05),
        "openings": ops,
        "furniture": furn,
        "seats": seats,
        "hallFins": hall_fins,
        "roundFins": round_fins,
        "legs": legs_m,
        "diagonal": diag_m,
        "eastGlass": rnd(fr.plan_to_m(east_glass)),
        "room28": room28,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"school-plan: совмещение {err:.2f} px, {px_m:.2f} px/м, стен 1-го этажа {len(walls_outer)}+{len(walls_inner)}, "
        f"верхних {len(data['wallsUpper'])}, проёмов {len(ops)}, мебели {len(furn)}, "
        f"рядов кресел {len(seats['rows'])} (шаг {seats['pitch']} м), плавников {len(hall_fins)}+{len(round_fins)}, "
        f"{OUT.stat().st_size // 1024} КБ"
    )

    # Контрольная картинка в метрах: силуэт, стены, проёмы, перегородки, мебель, кресла
    dbg = np.full((*G_shape, 3), 30, np.uint8)
    dbg[body > 0] = (60, 50, 60)
    dbg[footprint > 0] = (80, 70, 80)
    dbg[slab_mid > 0] = (90, 90, 120)
    dbg[round_g > 0] = (120, 90, 60)
    dbg[upper > 0] = (0, 200, 255)
    dbg[to_grid_plan(inner_wall) > 100] = (60, 60, 255)
    dbg[to_grid_plan(outer_wall) > 100] = (0, 140, 255)
    dbg[to_grid_plan(hall_wall) > 100] = (255, 80, 200)
    for poly in data["hallFloor"]:
        cv2.polylines(dbg, [fr.m_to_grid(poly["outer"]).round().astype(np.int32)], True, (255, 255, 255), 1)
    cv2.polylines(dbg, [fr.m_to_grid(data["roundCore"][0]["outer"]).round().astype(np.int32)], True, (0, 255, 0), 1)
    to_px = lambda pts: fr.m_to_grid(pts).round().astype(np.int32)
    for o in ops:
        cv2.polylines(dbg, [to_px(o["poly"])], True, (0, 255, 0) if o["kind"] == "outer" else (255, 255, 0), 2)
    for f in furn:
        cv2.polylines(dbg, [to_px(f["poly"])], True, (255, 0, 255), 1)
    for r in seats["rows"]:
        for x in r["x"]:
            cv2.circle(dbg, tuple(to_px([[x, r["z"]]])[0]), 3, (255, 255, 255), -1)
    for f in hall_fins + round_fins:
        cv2.circle(dbg, tuple(to_px([f["p"]])[0]), 3, (0, 255, 255), -1)
    for leg in legs_m:
        cv2.circle(dbg, tuple(to_px([leg["p"]])[0]), 5, (255, 128, 0), -1)
    cv2.polylines(dbg, [to_px(diag_m)], False, (255, 128, 0), 2)
    cv2.polylines(dbg, [to_px(room28)], True, (255, 128, 0), 2)
    for s in skylights:
        cv2.rectangle(dbg, tuple(to_px([s[:2]])[0]), tuple(to_px([s[2:]])[0]), (200, 200, 200), 1)
    DEBUG.mkdir(exist_ok=True)
    cv2.imwrite(str(DEBUG / "school-plan.png"), dbg)


if __name__ == "__main__":
    main()
