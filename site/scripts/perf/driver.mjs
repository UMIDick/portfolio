/**
 * Драйвер Chrome через CDP (без зависимостей: WebSocket и fetch встроены в Node ≥ 22):
 * запуск браузера, ввод (колесо, клики, клавиши), отметки фаз, трассировка.
 * Сборщик на странице пишет long-animation-frame (с атрибуцией скриптов),
 * паузы главного потока (по таймеру) и долгие события ввода в window.__prof.
 * Chrome — переменная CHROME (по умолчанию стандартный путь установки);
 * профиль браузера и результаты — в site/.perf (OUT_DIR). COLD=1 — чистый профиль
 * (холодные кэши кода и шейдеров, как у первого визита), CPU=4 — замедление процессора.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.perf");
mkdirSync(OUT_DIR, { recursive: true });
export const out = (name) => path.join(OUT_DIR, name);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const W = 1600;
export const H = 1000;
const COLLECTOR = `
  window.__prof = { loaf: [], gaps: [], marks: [], events: [] };
  window.__mark = (name) => window.__prof.marks.push({ name, t: performance.now() });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__prof.loaf.push({
          start: e.startTime, dur: e.duration, block: e.blockingDuration,
          render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
          styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: (e.scripts || []).map((s) => ({
            name: s.invoker || s.name, type: s.invokerType, src: (s.sourceURL || "").split("/").slice(-1)[0],
            fn: s.sourceFunctionName, line: s.sourceCharPosition, dur: s.duration, forced: s.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__prof.events.push({ name: e.name, start: e.startTime, dur: e.duration, delay: e.processingStart - e.startTime });
    }).observe({ type: "event", durationThreshold: 40, buffered: true });
  } catch (e) {}
  // Пропуски главного потока — таймером, а не rAF: постоянный цикл rAF сам заставлял бы
  // браузер рисовать кадры и отнимал бы у страницы простой (requestIdleCallback)
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const gap = now - last;
    if (gap > 28) window.__prof.gaps.push({ t: last, gap: Math.round(gap) });
    last = now;
    setTimeout(loop, 4);
  };
  setTimeout(loop, 4);
`;

export async function launch({ port = 9333, cpu = Number(process.env.CPU ?? 1) } = {}) {
  const dir = path.join(OUT_DIR, "chrome-profile");
  if (process.env.COLD) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const chrome = spawn(
    process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      `--window-size=${W},${H}`,
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--force-device-scale-factor=1",
      "--disable-background-timer-throttling",
      // Окно замера могут перекрыть другие окна — Windows тогда останавливает кадры
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error("Chrome не поднялся");
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    } else listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
  };
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: COLLECTOR });
  if (cpu > 1) await send("Emulation.setCPUThrottlingRate", { rate: cpu });

  const rect = (sel) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  const move = (x, y) => mouse("mouseMoved", x, y);
  const click = async (x, y) => {
    await move(x, y);
    await sleep(30);
    await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
    await sleep(40);
    await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
  };
  const wheel = async (x, y, dy, n = 1, gap = 60) => {
    for (let i = 0; i < n; i++) {
      await mouse("mouseWheel", x, y, { deltaX: 0, deltaY: dy });
      await sleep(gap);
    }
  };
  const key = async (keyName, code, keyCode) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
  };
  const clickSel = async (sel) => {
    const r = await rect(sel);
    if (!r) throw new Error("нет элемента " + sel);
    await click(r.x, r.y);
  };
  const mark = (name) => {
    console.log("→", name);
    return evaluate(`performance.mark(${JSON.stringify(name)}), (window.__mark && window.__mark(${JSON.stringify(name)})), 1`);
  };

  // ── Трассировка ──
  let traceEvents = [];
  on("Tracing.dataCollected", (p) => traceEvents.push(...p.value));
  const traceStart = async () => {
    traceEvents = [];
    await send("Tracing.start", {
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: [
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "devtools.timeline",
          "blink.user_timing",
          "cc",
          "gpu",
          "viz",
          "toplevel",
          "v8.execute",
          "benchmark",
          "loading",
          // SKIA=1 — какие шейдеры компилирует GPU-процесс (первый визит: first.mjs)
          ...(process.env.SKIA ? ["skia.shaders", "disabled-by-default-skia.shaders", "skia.gpu", "disabled-by-default-skia.gpu"] : []),
        ],
      },
    });
  };
  const traceStop = async (file) => {
    const done = new Promise((r) => on("Tracing.tracingComplete", r));
    await send("Tracing.end");
    await done;
    writeFileSync(out(file), JSON.stringify({ traceEvents }));
    console.log("trace", out(file), traceEvents.length, "событий");
  };

  return {
    send,
    on,
    evaluate,
    rect,
    mouse,
    move,
    click,
    wheel,
    key,
    clickSel,
    mark,
    traceStart,
    traceStop,
    navigate: (url) => send("Page.navigate", { url }),
    collect: async (file) => {
      writeFileSync(out(file), await evaluate("JSON.stringify(window.__prof)"));
      console.log("prof", out(file));
    },
    close: () => {
      ws.close();
      chrome.kill();
    },
  };
}
