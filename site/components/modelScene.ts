/**
 * Сцена 3D-макета проекта (карточка, здание, контур «печати») и общий WebGL-рендерер.
 *
 * Сцены готовятся заранее и кэшируются на всё время работы страницы: на главной —
 * в свободное время и при наведении на карточку (ModelPreload), на странице
 * проекта — соседние проекты. Подготовка идёт короткими шагами между кадрами:
 * загрузка, декодирование картинок вне главного потока, сборка геометрии,
 * параллельная компиляция шейдеров и «прогревочный» кадр (загрузка геометрии
 * и текстур в видеопамять, шейдеры теней). Поэтому при переходе на страницу
 * проекта анимация не ждёт ни сети, ни компиляции — холст просто вставляется.
 *
 * Рендерер один на весь сайт (один WebGL-контекст): программы шейдеров
 * и загруженные буферы переживают переходы между страницами.
 * Камера, анимации и управление — в ProjectModel.
 */
import * as THREE from "three";
import type * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { idlePause, isBusy } from "@/lib/idle";

export { THREE };
export { OrbitControls } from "three/addons/controls/OrbitControls.js";

const { Vector3, Color, Shape, Path, Plane, Mesh, Group, LineSegments, BufferGeometry, Float32BufferAttribute } = THREE;

export type Ring = [number, number][];
export interface Poly {
  outer: Ring;
  holes: Ring[];
}
/** Макет, собранный из иконки (scripts/make-models.py). */
export interface ProceduralData {
  format?: 1;
  floors: number;
  floorHeight: number;
  roof: boolean;
  bounds: [[number, number], [number, number]];
  walls: Poly[];
  annex: Poly[];
  slab: Poly[];
  /** Остекление по контуру; rail — доля высоты этажа под глухим ограждением. */
  glazing: Poly[];
  rail: number;
  parapet: Poly[];
  /** Глухие участки фасада под окна: концы и внешняя нормаль. */
  facades: { a: [number, number]; b: [number, number]; n: [number, number] }[];
  /** Окна: шаг вдоль фасада и доли — ширина от шага, низ и верх от высоты этажа. */
  windows: { spacing: number; width: number; sill: number; head: number } | null;
  canopy: { height: number; slab: Poly[]; posts: [number, number][] } | null;
  lifted: { region: Ring; wallsGround: Poly[]; legs: { p: [number, number]; t: [number, number] }[] } | null;
}
/**
 * Детальный макет (school: scripts/make-school-ifc.py из IFC): готовая геометрия
 * в GLB — по мешу на материал (имя материала = ключ в buildDetailed), без нормалей.
 */
export interface DetailedData {
  format: 2;
  /** Файл модели рядом с model.json. */
  model: string;
  height: number;
  bounds: [[number, number], [number, number]];
  /** Контур здания — для вписывания камеры. */
  outline: Ring[];
  /** Контуры стен 1-го этажа — светящийся срез при «печати». */
  scan: Ring[];
  /** Уровень пола 1-го этажа: отсюда «печатается» здание (ниже — фундаментная плита). */
  base?: number;
  buildMs: number;
}
export type ModelData = ProceduralData | DetailedData;

export interface ModelSource {
  slug: string;
  icon: string;
  ink: string;
  bg: string;
}

/** Скругление углов карточки — как в PNG иконки (дуга радиусом 199/1189). */
export const CARD_RADIUS = 0.1674;
export const CARD_DEPTH = 0.028;
/** Белый обложки (#e9e9ed): обводка границы земли и торец плиты карточки. */
const CARD_RIM = 0xe9e9ed;
/** Ширина белой обводки на верхней грани карточки (сторона карточки = 1). */
const CARD_RIM_WIDTH = 0.007;
const CARD_RIM_OVERHANG = 0.0012;
/** Торец плиты карточки. */
const CARD_SIDE = 0xa9a9b3;
export const SLAB = 0.006;
export const PARAPET = 0.012;
/** Разлёт V-образной опоры вдоль края объёма. */
export const LEG_SPREAD = 0.016;
/** Шаг стоек в переплётах остекления. */
export const MULLION_STEP = 0.028;

/** Плотность тени здания на карточке. */
const SHADOW_OPACITY = 0.4;

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

// ── Общий рендерер ──

interface Shared {
  renderer: T.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** Перерисовать кадр показанного макета (после прогрева холст мог показать чужую сцену). */
  redraw: (() => void) | null;
}
let shared: Shared | null = null;

export function getRenderer(): Shared {
  if (shared) return shared;
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  // Проверка ошибок шейдеров ждёт окончания компиляции синхронно — в продакшене не нужна
  renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";
  renderer.setClearColor(0x000000, 0);
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Солнце неподвижно: карта теней пересчитывается, только пока здание собирается
  renderer.shadowMap.autoUpdate = false;
  const s: Shared = { renderer, canvas, redraw: null };
  canvas.addEventListener("webglcontextlost", () => {
    // Контекст потерян — всё собираем заново при следующем показе
    if (shared === s) shared = null;
    cache.clear();
    prepared.clear();
  });
  shared = s;
  return s;
}

const sizeProbe = new THREE.Vector2();
/**
 * Размер холста (CSS-пиксели) и плотность. Буфер холста пересоздаётся, только если
 * он действительно меняется: у three setSize/setPixelRatio всегда выделяют его
 * заново (с MSAA это заметная пауза), а при монтировании их зовут несколько раз.
 */
export function sizeCanvas(width: number, height: number, ratio: number) {
  const { renderer } = getRenderer();
  const size = renderer.getSize(sizeProbe);
  if (size.x === width && size.y === height && renderer.getPixelRatio() === ratio) return;
  renderer.setDrawingBufferSize(width, height, ratio);
}

/** Потолок плотности пикселей холста (ProjectModel может снижать её в покое). */
export const MAX_DPR = 2;

/**
 * Ожидаемый размер холста на странице проекта: ячейка иконки — колонка
 * minmax(140px, min(320px, 30svh)) (app/projects/[slug]/page.module.css), холст —
 * шире и выше ячейки (ProjectModel.module.css: inset -52% -22% -16% -30%).
 * Прогрев сразу в этом размере — при показе буфер не пересоздаётся.
 */
function expectedCanvasSize() {
  const cell = window.innerWidth > 760 ? Math.max(140, Math.min(320, window.innerHeight * 0.3)) : 0;
  if (!cell) return null;
  return { width: Math.round(cell * 1.52), height: Math.round(cell * 1.68) };
}

export function setRedraw(fn: (() => void) | null) {
  if (shared) shared.redraw = fn;
}

// ── Кэш сцен ──

export interface ModelScene {
  data: ModelData;
  scene: T.Scene;
  building: T.Group;
  clip: T.Plane;
  scan: T.LineSegments;
  scanMat: T.LineBasicMaterial;
  /** Верх здания. */
  totalH: number;
  /** Уровень, с которого растёт здание при «печати». */
  baseH: number;
  buildMs: number;
  /** Точки кровли для вписывания камеры. */
  roofOutline: [number, number][];
  setLabels: (opacity: number) => void;
  setPlate: (opacity: number) => void;
  /** Тонкие линии детального макета: на маленькой карточке тише. */
  setLineDetail: (cardPx: number) => void;
  /** Проявление всех линий (рёбра, переплёты, край карточки), 0…1. */
  setLineFade: (k: number) => void;
  /** Сила тени на карточке, 0…1: у только начатого здания срез почти лежит
      на карточке и тень от него идёт рябью — поэтому она набирается постепенно. */
  setShadowStrength: (k: number) => void;
  /** Режим разреза: пока здание «печатается», непрозрачные поверхности двусторонние
      (виден срез). У готового здания изнанка отсекается — вдвое меньше закраски,
      это заметно при приближении на весь экран. Оба варианта шейдеров компилируются
      заранее (сторона входит в ключ программы — иначе переключение вызвало бы паузу). */
  setCutaway: (on: boolean) => void;
  /** Исходное состояние перед показом: здание не построено, надписи видны. */
  reset: () => void;
}

const cache = new Map<string, Promise<ModelScene>>();
const prepared = new Set<string>();

export const isPrepared = (slug: string) => prepared.has(slug);
export const isPreparing = (slug: string) => cache.has(slug);

type Pause = () => Promise<void>;
/** Пауза до настоящего простоя (lib/idle): шаг подготовки не должен срывать кадр. */
export { idlePause };
/** Между кадрами: даём браузеру отрисовать кадр и продолжаем. */
const framePause: Pause = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
/** Срочный шаг — между кадрами, но не посреди перехода между страницами или перелистывания
    (markBusy): шаги по 50–100 мс в последней трети раскрытия страницы давали рывки. */
const urgentPause: Pause = async () => {
  while (isBusy()) await new Promise((r) => setTimeout(r, 50));
  await framePause();
};

/** Срочность идущих сборок: фоновая сборка ускоряется, когда страница проекта её ждёт. */
const urgency = new Map<string, { urgent: boolean }>();

/**
 * Готовая сцена проекта (из кэша или собранная). urgent — страница проекта ждёт
 * её прямо сейчас: шаги идут между кадрами, а не в простое браузера (уже начатая
 * в фоне сборка тоже переходит на этот темп).
 */
export function prepareModel(src: ModelSource, { urgent = false } = {}): Promise<ModelScene> {
  let p = cache.get(src.slug);
  if (p && urgent) {
    const u = urgency.get(src.slug);
    if (u) u.urgent = true;
  }
  if (!p) {
    const u = { urgent };
    urgency.set(src.slug, u);
    p = build(src, () => (u.urgent ? urgentPause() : idlePause({ calm: true })), !urgent);
    cache.set(src.slug, p);
    p.finally(() => urgency.delete(src.slug)).catch(() => {});
    p.then(
      () => prepared.add(src.slug),
      () => cache.delete(src.slug),
    );
  }
  return p;
}

// Фоновая очередь: по одному проекту, первым — тот, на который навели
const queue: ModelSource[] = [];
let running = false;
let drained: Promise<void> = Promise.resolve();
/** Ставит проекты в очередь; промис — когда очередь опустеет. */
export function preloadModels(list: ModelSource[], first?: string): Promise<void> {
  for (const s of list) if (!cache.has(s.slug) && !queue.some((q) => q.slug === s.slug)) queue.push(s);
  if (first) {
    const i = queue.findIndex((q) => q.slug === first);
    // Проект, на который навели, готовим сразу, не дожидаясь того, что уже собирается:
    // иначе к клику его сборка часто ещё не начата и шла бы в конце перехода на страницу
    if (i >= 0 && running) void prepareModel(queue.splice(i, 1)[0]).catch(() => {});
    else if (i > 0) queue.unshift(...queue.splice(i, 1));
  }
  if (running) return drained;
  running = true;
  drained = (async () => {
    while (queue.length) {
      const s = queue.shift()!;
      await prepareModel(s).catch(() => {});
    }
    running = false;
  })();
  return drained;
}

/** Картинка для текстуры; декодирование вне главного потока (createImageBitmap). */
async function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  try {
    const blob = await (await fetch(url)).blob();
    return await createImageBitmap(blob, {
      imageOrientation: "flipY",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }
}

function makeTexture(img: ImageBitmap | HTMLImageElement, renderer: T.WebGLRenderer) {
  const tex = new THREE.Texture(img);
  // ImageBitmap уже перевёрнут при декодировании
  tex.flipY = !(typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** Декодер meshopt — в воркере: распаковка GLB школы иначе занимает главный поток. */
let meshoptWorkers = false;
function meshoptDecoder() {
  if (!meshoptWorkers) {
    meshoptWorkers = true;
    try {
      MeshoptDecoder.useWorkers(1);
    } catch {
      // Воркер из blob недоступен — декодируем в главном потоке
    }
  }
  return MeshoptDecoder;
}

/** Холст уже побывал в кадре страницы (см. конец build). */
let canvasComposited = false;

async function build({ slug, icon, ink, bg }: ModelSource, pause: Pause, background: boolean): Promise<ModelScene> {
  const disposables: { dispose: () => void }[] = [];
  const track = <D extends { dispose: () => void }>(x: D) => (disposables.push(x), x);

  const data = (await (await fetch(`/projects/${slug}/model.json`)).json()) as ModelData;
  const [gltf, iconImg, plateImg] = await Promise.all([
    data.format === 2
      ? // Макет из IFC сжат gltfpack (meshopt + квантование)
        new GLTFLoader().setMeshoptDecoder(meshoptDecoder()).loadAsync(`/projects/${slug}/${data.model}`)
      : null,
    loadImage(icon),
    loadImage(`/projects/${slug}/plate.png`),
  ]);
  await pause();
  // Контекст WebGL создаётся здесь: это синхронный запрос к процессу GPU (десятки
  // миллисекунд), поэтому он идёт отдельным шагом, а не вместе с исполнением модуля
  const { renderer } = getRenderer();
  const texture = makeTexture(iconImg, renderer);
  const plateTexture = makeTexture(plateImg, renderer);
  await pause();

  const scene = new THREE.Scene();
  const inkColor = new Color(ink);
  const bgColor = new Color(bg);
  const white = new Color("#ffffff");

  scene.add(new THREE.HemisphereLight(0xffffff, bgColor.clone().multiplyScalar(0.8), 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-1.1, 2.4, 1.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -1;
  sun.shadow.camera.right = 1;
  sun.shadow.camera.top = 1;
  sun.shadow.camera.bottom = -1;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  sun.shadow.radius = 3;
  scene.add(sun);

  // Непрозрачные материалы: пока здание «печатается», они двусторонние (виден срез),
  // у готового — изнанка отсекается (вдвое меньше закраски при приближении)
  const solidMats: T.MeshStandardMaterial[] = [];
  const setCutaway = (on: boolean) => {
    for (const m of solidMats) m.side = on ? THREE.DoubleSide : THREE.FrontSide;
  };

  // Линии с базовой прозрачностью: проявляются вместе с макетом
  const lineList: { mat: T.LineBasicMaterial | T.MeshBasicMaterial; base: number }[] = [];
  let lineFade = 1;
  const applyLines = () => {
    for (const l of lineList) {
      l.mat.opacity = l.base * lineFade;
      l.mat.visible = lineFade > 0.001;
    }
  };

  // Углы — дуги окружности, как у PNG иконки (иначе край толщины расходится с рамкой)
  const roundedRect = (inset = 0) => {
    const s = new Shape();
    const h = 0.5 - inset;
    const r = CARD_RADIUS - inset;
    s.moveTo(-h + r, -h);
    s.lineTo(h - r, -h);
    s.absarc(h - r, -h + r, r, -Math.PI / 2, 0, false);
    s.lineTo(h, h - r);
    s.absarc(h - r, h - r, r, 0, Math.PI / 2, false);
    s.lineTo(-h + r, h);
    s.absarc(-h + r, h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(-h, -h + r);
    s.absarc(-h + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  };

  const cardTopGeo = track(new THREE.PlaneGeometry(1, 1));
  cardTopGeo.rotateX(-Math.PI / 2);
  // Земля под рисунком — фон самой картинки карточки: когда план гаснет, под ним
  // остаётся ровно тот же бордовый, а не подсвеченная плита карточки
  const plateBg = (): T.Color => {
    const img = plateTexture.image as CanvasImageSource & { width: number; height: number };
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      // Точка у левого края по центру — заведомо фон (углы карточки прозрачны)
      ctx.drawImage(img, Math.round(img.width * 0.012), Math.round(img.height / 2), 4, 4, 0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (a > 200) return new Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    } catch {
      /* холст может быть недоступен — берём фон палитры */
    }
    return bgColor.clone();
  };
  // Форма — та же скруглённая карточка: квадратная плоскость торчала бы на углах
  const groundGeo = track(new THREE.ShapeGeometry(roundedRect(), 48));
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new Mesh(groundGeo, track(new THREE.MeshBasicMaterial({ color: plateBg() })));
  ground.position.y = -0.0002;
  ground.renderOrder = 0;
  scene.add(ground);

  const plateMat = track(new THREE.MeshBasicMaterial({ map: plateTexture, transparent: true, depthWrite: false }));
  const plate = new Mesh(cardTopGeo, plateMat);
  plate.renderOrder = 1;
  scene.add(plate);
  /** Рисунок плана на карточке: гаснет, когда начинается «печать» (земля остаётся). */
  const setPlate = (opacity: number) => {
    plateMat.opacity = opacity;
    plate.visible = opacity > 0.001;
  };
  const labelsMat = track(new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
  const labels = new Mesh(cardTopGeo, labelsMat);
  labels.renderOrder = 1.5;
  scene.add(labels);
  const setLabels = (opacity: number) => {
    labelsMat.opacity = opacity;
    labels.visible = opacity > 0;
  };

  const bodyGeo = track(
    new THREE.ExtrudeGeometry(roundedRect(), { depth: CARD_DEPTH, bevelEnabled: false, curveSegments: 48 }),
  );
  bodyGeo.rotateX(-Math.PI / 2);
  bodyGeo.translate(0, -CARD_DEPTH - 0.0006, 0);
  const body = new Mesh(
    bodyGeo,
    // Торец плиты — сероватый: белым он сливался с обводкой в одно целое
    // (верх закрыт «землёй» — ground)
    track(new THREE.MeshStandardMaterial({ color: CARD_SIDE, roughness: 0.85 })),
  );
  body.receiveShadow = true;
  scene.add(body);
  const bodyEdges = new LineSegments(
    track(new THREE.EdgesGeometry(bodyGeo, 30)),
    // Белая обводка по границе земли, на которой стоит здание
    track(new THREE.LineBasicMaterial({ color: CARD_RIM, transparent: true, opacity: 0.95 })),
  );
  scene.add(bodyEdges);
  lineList.push({ mat: bodyEdges.material as T.LineBasicMaterial, base: 0.95 });

  // Белая обводка по границе земли — полоса на верхней грани, как рамка у иконки:
  // линия в 1 px по ребру сливалась с белым торцом и сверху не читалась.
  // Проявляется вместе с линиями макета (пока карточка ложится, рамку даёт сама картинка)
  // Наружу полоса чуть шире плиты: иначе между ней и торцом проглядывал тёмный шов
  // (край «земли» и зазор до плиты)
  const rimShape = roundedRect(-CARD_RIM_OVERHANG);
  rimShape.holes.push(roundedRect(CARD_RIM_WIDTH));
  const rimGeo = track(new THREE.ShapeGeometry(rimShape, 48));
  rimGeo.rotateX(-Math.PI / 2);
  const rimMat = track(new THREE.MeshBasicMaterial({ color: CARD_RIM, transparent: true, depthWrite: false }));
  const rim = new Mesh(rimGeo, rimMat);
  rim.position.y = 0.001;
  rim.renderOrder = 2.5;
  scene.add(rim);
  lineList.push({ mat: rimMat, base: 1 });

  // Тени от здания ложатся на карточку отдельным прозрачным слоем
  const shadowGeo = track(new THREE.ShapeGeometry(roundedRect(), 48));
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowCatcher = new Mesh(
    shadowGeo,
    track(new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY, depthWrite: false })),
  );
  shadowCatcher.position.y = 0.0008;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 2;
  scene.add(shadowCatcher);

  // ── Здание ──
  const clip = new Plane(new Vector3(0, -1, 0), 0);

  // Контур из JSON: x вправо, z вниз по картинке. Фигура строится в плоскости XY
  // как (x, -z), после поворота на -90° вокруг X выдавливание идёт вверх по Y.
  const toShapes = (polys: Poly[]) =>
    polys.map((p) => {
      const s = new Shape(p.outer.map(([x, z]) => new THREE.Vector2(x, -z)));
      s.holes = p.holes.map((h) => new Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
      return s;
    });
  const extrude = (polys: Poly[], depth: number) => {
    const g = new THREE.ExtrudeGeometry(toShapes(polys), { depth, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    return track(g);
  };

  const wallMat = track(
    new THREE.MeshStandardMaterial({
      color: inkColor.clone().lerp(white, 0.35),
      roughness: 0.55,
      metalness: 0.05,
      clippingPlanes: [clip],
      clipShadows: true,
    }),
  );
  const slabMat = track(
    new THREE.MeshStandardMaterial({
      color: bgColor.clone().lerp(inkColor, 0.5),
      roughness: 0.7,
      clippingPlanes: [clip],
      clipShadows: true,
    }),
  );
  const edgeMat = track(
    new THREE.LineBasicMaterial({
      color: inkColor.clone().lerp(white, 0.15),
      transparent: true,
      opacity: 0.9,
      clippingPlanes: [clip],
    }),
  );
  lineList.push({ mat: edgeMat, base: 0.9 });

  const building = new Group();
  scene.add(building);
  const addSolid = (geo: T.BufferGeometry, mat: T.Material, y: number) => {
    const m = new Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    building.add(m);
    return m;
  };
  const addEdges = (geo: T.BufferGeometry, y: number) => {
    const l = new LineSegments(geo, edgeMat);
    l.position.y = y;
    building.add(l);
  };

  /** Макет из иконки: этажи, остекление, окна, навес, опоры. Возвращает верх здания. */
  // Части строятся с паузами между кадрами: остекление, окна и опоры — самые
  // тяжёлые (EdgesGeometry, слияние сотен мелких геометрий)
  const buildProcedural = async (data: ProceduralData) => {
    const fh = data.floorHeight;
    const multi = data.floors > 1;
    const wallH = multi ? fh - SLAB : fh;
    const withEdges = (geo: T.BufferGeometry) => ({ geo, edges: track(new THREE.EdgesGeometry(geo, 24)) });
    const walls = withEdges(extrude(data.walls, wallH));
    const slab = data.slab.length ? withEdges(extrude(data.slab, SLAB)) : null;

    // Поднятый на опоры объём: на первом этаже там нет стен
    const lifted = data.lifted;
    const wallsGround = lifted ? withEdges(extrude(lifted.wallsGround, wallH)) : walls;
    const inLifted = (x: number, z: number) => {
      if (!lifted) return false;
      const ring = lifted.region;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i];
        const [xj, zj] = ring[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };

    await pause();
    // Остекление по контуру (окна, лоджии): внизу глухое ограждение, выше — стекло
    const railH = wallH * data.rail;
    const rail = data.glazing.length && railH > 0 ? withEdges(extrude(data.glazing, railH)) : null;
    const glass = data.glazing.length ? withEdges(extrude(data.glazing, wallH - railH)) : null;
    // Переплёты остекления: вдоль главной оси каждой полосы — стойки и два ригеля
    const glassGrid = (() => {
      if (!glass) return null;
      const gh = wallH - railH;
      const lines: number[] = [];
      for (const { outer } of data.glazing) {
        const n = outer.length;
        const mx = outer.reduce((a, [x]) => a + x, 0) / n;
        const mz = outer.reduce((a, [, z]) => a + z, 0) / n;
        let sxx = 0;
        let szz = 0;
        let sxz = 0;
        for (const [x, z] of outer) {
          sxx += (x - mx) ** 2;
          szz += (z - mz) ** 2;
          sxz += (x - mx) * (z - mz);
        }
        const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
        const [dx, dz] = [Math.cos(angle), Math.sin(angle)];
        const proj = outer.map(([x, z]) => (x - mx) * dx + (z - mz) * dz);
        const from = Math.min(...proj);
        const len = Math.max(...proj) - from;
        if (len < 0.012) continue;
        const at = (d: number, y: number) => [mx + dx * d, y, mz + dz * d];
        const count = Math.max(1, Math.round(len / MULLION_STEP));
        for (let k = 1; k < count; k++) {
          const d = from + (k * len) / count;
          lines.push(...at(d, 0), ...at(d, gh));
        }
        for (const f of [0.36, 0.72]) lines.push(...at(from, gh * f), ...at(from + len, gh * f));
      }
      const g = track(new BufferGeometry());
      g.setAttribute("position", new Float32BufferAttribute(lines, 3));
      return g;
    })();

    await pause();
    // Окна на глухих участках фасада: стекло чуть снаружи стены, рама и импост
    const makeWindows = (skipLifted: boolean) => {
      const w = data.windows;
      if (!w || !data.facades.length) return null;
      const panes: number[] = [];
      const frames: number[] = [];
      const y0 = w.sill * wallH;
      const y1 = w.head * wallH;
      const ym = y0 + (y1 - y0) * 0.62;
      for (const f of data.facades) {
        const [ax, az] = f.a;
        const [bx, bz] = f.b;
        const len = Math.hypot(bx - ax, bz - az);
        const tx = (bx - ax) / len;
        const tz = (bz - az) / len;
        const count = Math.max(1, Math.floor(len / w.spacing));
        const step = len / count;
        const half = (step * w.width) / 2;
        for (let k = 0; k < count; k++) {
          const c = (k + 0.5) * step;
          const cx = ax + tx * c + f.n[0] * 0.0012;
          const cz = az + tz * c + f.n[1] * 0.0012;
          if (skipLifted && inLifted(cx, cz)) continue;
          const [x0, z0, x1, z1] = [cx - tx * half, cz - tz * half, cx + tx * half, cz + tz * half];
          panes.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
          frames.push(
            ...[x0, y0, z0, x1, y0, z1],
            ...[x1, y0, z1, x1, y1, z1],
            ...[x1, y1, z1, x0, y1, z0],
            ...[x0, y1, z0, x0, y0, z0],
            ...[x0, ym, z0, x1, ym, z1],
          );
        }
      }
      const pane = track(new BufferGeometry());
      pane.setAttribute("position", new Float32BufferAttribute(panes, 3));
      pane.computeVertexNormals();
      const frame = track(new BufferGeometry());
      frame.setAttribute("position", new Float32BufferAttribute(frames, 3));
      return { pane, frame };
    };
    const windows = makeWindows(false);
    const windowsGround = lifted ? makeWindows(true) : windows;

    const paneMat = track(
      new THREE.MeshStandardMaterial({
        color: bgColor.clone().lerp(white, 0.1),
        emissive: inkColor.clone().multiplyScalar(0.06),
        roughness: 0.2,
        metalness: 0.3,
        side: THREE.DoubleSide,
        clippingPlanes: [clip],
      }),
    );
    const glassMat = track(
      new THREE.MeshStandardMaterial({
        color: inkColor.clone().lerp(white, 0.55),
        roughness: 0.1,
        metalness: 0.1,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        clippingPlanes: [clip],
      }),
    );
    const frameMat = track(
      new THREE.LineBasicMaterial({
        color: inkColor.clone().lerp(white, 0.5),
        transparent: true,
        opacity: 0.85,
        clippingPlanes: [clip],
      }),
    );
    lineList.push({ mat: frameMat, base: 0.85 });
    const addGlass = (geo: T.BufferGeometry, mat: T.Material, y: number) => {
      const m = new Mesh(geo, mat);
      m.position.y = y;
      m.receiveShadow = true;
      building.add(m);
    };
    const addLines = (geo: T.BufferGeometry, mat: T.LineBasicMaterial, y: number) => {
      const l = new LineSegments(geo, mat);
      l.position.y = y;
      building.add(l);
    };

    for (let i = 0; i < data.floors; i++) {
      const base = i * fh;
      if (slab && multi) {
        addSolid(slab.geo, slabMat, base);
        addEdges(slab.edges, base);
      }
      const y = base + (multi ? SLAB : 0);
      const w = i === 0 ? wallsGround : walls;
      addSolid(w.geo, wallMat, y);
      addEdges(w.edges, y);
      if (rail) {
        addSolid(rail.geo, wallMat, y);
        addEdges(rail.edges, y);
      }
      if (glass) {
        addGlass(glass.geo, glassMat, y + railH);
        addLines(glass.edges, frameMat, y + railH);
        if (glassGrid) addLines(glassGrid, frameMat, y + railH);
      }
      const win = i === 0 ? windowsGround : windows;
      if (win) {
        addGlass(win.pane, paneMat, y);
        addLines(win.frame, frameMat, y);
      }
    }
    await pause();
    let top = data.floors * fh;
    if (data.roof && slab) {
      addSolid(slab.geo, slabMat, top);
      addEdges(slab.edges, top);
      top += SLAB;
    }
    const roofTop = top;
    if (data.parapet.length) {
      const parapet = withEdges(extrude(data.parapet, PARAPET));
      addSolid(parapet.geo, wallMat, roofTop);
      addEdges(parapet.edges, roofTop);
      top += PARAPET;
    }
    if (data.annex.length) {
      const annex = withEdges(extrude(data.annex, fh * 0.6));
      addSolid(annex.geo, wallMat, 0);
      addEdges(annex.edges, 0);
    }

    // Навес-«корона» на стойках (башня)
    if (data.canopy) {
      const c = data.canopy;
      const posts = c.posts.map(([x, z]) => {
        const g = new THREE.BoxGeometry(0.0035, c.height, 0.0035);
        g.translate(x, roofTop + c.height / 2, z);
        return g;
      });
      if (posts.length) {
        const merged = track(mergeGeometries(posts)!);
        posts.forEach((g) => g.dispose());
        addSolid(merged, wallMat, 0);
      }
      const cap = withEdges(extrude(c.slab, SLAB));
      const capMat = track(
        new THREE.MeshStandardMaterial({
          color: white.clone().lerp(inkColor, 0.3),
          roughness: 0.6,
          clippingPlanes: [clip],
          clipShadows: true,
        }),
      );
      addSolid(cap.geo, capMat, roofTop + c.height);
      addEdges(cap.edges, roofTop + c.height);
      top = Math.max(top, roofTop + c.height + SLAB);
    }

    await pause();
    // V-образные опоры под поднятым объёмом (школа)
    if (lifted?.legs.length) {
      const up = new Vector3(0, 1, 0);
      const legs: T.BufferGeometry[] = [];
      for (const { p, t } of lifted.legs) {
        for (const side of [-1, 1]) {
          const from = new Vector3(p[0], 0, p[1]);
          const to = new Vector3(p[0] + t[0] * LEG_SPREAD * side, fh, p[1] + t[1] * LEG_SPREAD * side);
          const dir = to.clone().sub(from);
          const g = new THREE.CylinderGeometry(0.0026, 0.0026, dir.length(), 8);
          g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize()));
          g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
          legs.push(g);
        }
      }
      const merged = track(mergeGeometries(legs)!);
      legs.forEach((g) => g.dispose());
      addSolid(merged, wallMat, 0);
    }
    return top;
  };

  /** Тонкие линии детального макета: на маленькой карточке тише, на весь экран — чётче. */
  let setLineDetail: (cardPx: number) => void = () => {};

  /** Детальный макет из GLB: материалы по именам мешей. Возвращает верх здания. */
  const buildDetailed = (root: T.Object3D, info: DetailedData) => {
    const mix = (a: T.Color, b: T.Color, t: number) => a.clone().lerp(b, t);
    const std = (color: T.Color, extra: T.MeshStandardMaterialParameters = {}) => {
      const m = track(
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.6,
          metalness: 0.05,
          flatShading: true,
          side: THREE.DoubleSide,
          clippingPlanes: [clip],
          clipShadows: true,
          ...extra,
        }),
      );
      // Прозрачные (стекло) остаются двусторонними — это тонкие поверхности
      if (!m.transparent) solidMats.push(m);
      return m;
    };
    const accent = new Color("#d88fb6");
    const mats: Record<string, T.Material> = {
      wall: std(mix(inkColor, white, 0.35)),
      panel: std(mix(inkColor, white, 0.6)),
      dark: std(mix(bgColor, inkColor, 0.3)),
      slab: std(mix(bgColor, inkColor, 0.58), { roughness: 0.8 }),
      floor: std(mix(bgColor, inkColor, 0.3)),
      stage: std(mix(bgColor, inkColor, 0.62)),
      roofbox: std(mix(inkColor, white, 0.62)),
      frame: std(mix(inkColor, white, 0.55)),
      metal: std(mix(bgColor, white, 0.3)),
      stair: std(mix(inkColor, white, 0.2)),
      furn: std(mix(bgColor, white, 0.35)),
      // Интерьер квартиры (scripts/make-flat-ifc.py): отделка-плитка, мягкая мебель, сантехника
      tile: std(mix(bgColor, inkColor, 0.7)),
      fabric: std(mix(bgColor, inkColor, 0.85), { roughness: 0.9 }),
      white: std(mix(inkColor, white, 0.8), { roughness: 0.4 }),
      wood: std(new Color("#b39373").lerp(inkColor, 0.25)),
      rail: std(new Color("#b39373").lerp(white, 0.15), { roughness: 0.7 }),
      accent: std(accent),
      seat: std(new Color("#c2528f")),
      pane: std(mix(bgColor, white, 0.06), {
        emissive: inkColor.clone().multiplyScalar(0.08),
        roughness: 0.2,
        metalness: 0.3,
      }),
      glass: std(mix(inkColor, white, 0.55), {
        roughness: 0.1,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      }),
    };
    const lineMats: Record<string, T.LineBasicMaterial> = {
      edges: track(
        new THREE.LineBasicMaterial({
          color: mix(inkColor, white, 0.2),
          transparent: true,
          opacity: 0.5,
          clippingPlanes: [clip],
        }),
      ),
      lines: track(
        new THREE.LineBasicMaterial({
          color: mix(inkColor, white, 0.5),
          transparent: true,
          opacity: 0.45,
          clippingPlanes: [clip],
        }),
      ),
    };
    const edgesLine = { mat: lineMats.edges, base: 0.5 };
    const detailLine = { mat: lineMats.lines, base: 0.45 };
    lineList.push(edgesLine, detailLine);
    setLineDetail = (cardPx) => {
      const k = clamp01((cardPx - 300) / 900);
      edgesLine.base = 0.22 + 0.3 * k;
      detailLine.base = 0.1 + 0.35 * k;
      applyLines();
    };
    const parts: T.Object3D[] = [];
    root.traverse((o) => parts.push(o));
    for (const o of parts) {
      const m = o as T.Mesh | T.LineSegments;
      if (!(m as T.Mesh).isMesh && !(m as T.LineSegments).isLineSegments) continue;
      track(m.geometry);
      // Ключ — имя материала (gltfpack переносит имена мешей на родительские узлы)
      const key = (o.userData.mat ??= (m.material as T.Material).name || o.name) as string;
      track(m.material as T.Material);
      if ((m as T.LineSegments).isLineSegments) {
        m.material = lineMats[key] ?? lineMats.lines;
        continue;
      }
      m.material = mats[key] ?? mats.wall;
      // Стекло не отбрасывает тень, чтобы интерьер не тонул в темноте
      m.castShadow = key !== "glass" && key !== "pane";
      m.receiveShadow = true;
    }
    building.add(root);
    return info.height;
  };

  const totalH = data.format === 2 ? buildDetailed(gltf!.scene, data) : await buildProcedural(data);
  await pause();

  // Светящийся контур «печати» на текущей высоте
  const scanPositions: number[] = [];
  const pushRing = (ring: Ring) => {
    for (let k = 0; k < ring.length; k++) {
      const [x1, z1] = ring[k];
      const [x2, z2] = ring[(k + 1) % ring.length];
      scanPositions.push(x1, 0, z1, x2, 0, z2);
    }
  };
  if (data.format === 2) data.scan.forEach(pushRing);
  else
    for (const p of [...data.walls, ...data.glazing, ...data.slab]) {
      pushRing(p.outer);
      p.holes.forEach(pushRing);
    }
  const scanGeo = track(new BufferGeometry());
  scanGeo.setAttribute("position", new Float32BufferAttribute(scanPositions, 3));
  const scanMat = track(
    new THREE.LineBasicMaterial({
      color: inkColor.clone().lerp(white, 0.55),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const scan = new LineSegments(scanGeo, scanMat);
  scene.add(scan);

  // Точки кровли для вписывания камеры: контур перекрытия (точнее габаритов плана)
  const [[bx0, bz0], [bx1, bz1]] = data.bounds;
  const roofOutline: [number, number][] =
    data.format === 2
      ? data.outline.flatMap((r) => r.filter((_, i) => i % 3 === 0))
      : data.slab.length
        ? data.slab.flatMap((p) => p.outer.filter((_, i) => i % 3 === 0))
        : [
            [bx0, bz0],
            [bx1, bz0],
            [bx0, bz1],
            [bx1, bz1],
          ];

  const setShadowStrength = (k: number) => {
    shadowCatcher.material.opacity = SHADOW_OPACITY * clamp01(k);
  };
  const setLineFade = (k: number) => {
    lineFade = k;
    applyLines();
  };
  const reset = () => {
    clip.constant = -0.001;
    scan.position.y = 0;
    scanMat.opacity = 0;
    setLabels(1);
    setPlate(1);
    setLineFade(0);
    setShadowStrength(0);
    setCutaway(true);
  };

  // ── Прогрев: шейдеры компилируются параллельно, затем один кадр целиком
  // (загрузка буферов и текстур, шейдеры теней). Всё видимо — компилируется всё.
  await pause();
  const expected = expectedCanvasSize();
  if (expected && !getRenderer().canvas.isConnected) {
    sizeCanvas(expected.width, expected.height, Math.min(window.devicePixelRatio, MAX_DPR));
  }
  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
  camera.position.set(0.4, 2.2, 1.6);
  camera.lookAt(0, 0, 0);
  clip.constant = totalH + 1;
  setLineFade(1);
  setShadowStrength(1);
  scanMat.opacity = 0.01;
  for (const tex of [texture, plateTexture]) {
    renderer.initTexture(tex);
    await pause();
  }
  // Оба варианта: с отсечением изнанки (готовое здание) и без (пока виден срез)
  for (const cutaway of [false, true]) {
    setCutaway(cutaway);
    await renderer.compileAsync(scene, camera);
    await pause();
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    await pause();
  }
  // Холст ещё ни разу не был на странице: под первый кадр с ним компоновщик браузера
  // компилирует свои шейдеры (2 программы, ~50 мс — рывок в момент появления макета).
  // В фоне показываем его на пару кадров невидимо (.gpu-warm в globals.css)
  const { canvas } = getRenderer();
  if (background && !canvasComposited && !canvas.isConnected) {
    canvasComposited = true;
    const holder = document.createElement("div");
    holder.className = "gpu-warm";
    holder.setAttribute("aria-hidden", "true");
    canvas.className = "";
    holder.appendChild(canvas);
    document.body.appendChild(holder);
    renderer.render(scene, camera);
    await framePause();
    await framePause();
    // За это время холст могла забрать страница проекта
    if (canvas.parentElement === holder) canvas.remove();
    holder.remove();
    await pause();
  }
  // Холст мог показывать другой макет — перерисовываем его в том же кадре
  shared?.redraw?.();
  reset();

  return {
    data,
    scene,
    building,
    clip,
    scan,
    scanMat,
    totalH,
    baseH: data.format === 2 ? (data.base ?? 0) : 0,
    buildMs: data.format === 2 ? data.buildMs : Math.min(1500 + data.floors * 150, 4000),
    roofOutline,
    setLabels,
    setPlate,
    setLineDetail,
    setLineFade,
    setShadowStrength,
    setCutaway,
    reset,
  };
}
