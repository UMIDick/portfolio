"use client";

import { useEffect, useState, type CSSProperties } from "react";
import styles from "./Intro.module.css";

/**
 * Интро: обложка портфолио, перерисованная в HTML.
 * Сетка 11×12 с шагом --u * 1.1; каждая буква — сетка 6 строк × 4–5 колонок
 * маленьких «u». Глифы сверены 1:1 с обложкой архитектора.
 */

const GLYPHS: Record<string, string[]> = {
  P: ["1110", "1001", "1001", "1110", "1000", "1000"],
  O: ["01110", "10001", "10001", "10001", "10001", "01110"],
  R: ["1110", "1001", "1110", "1001", "1001", "1001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100"],
  F: ["1111", "1000", "1110", "1000", "1000", "1000"],
  L: ["1000", "1000", "1000", "1000", "1000", "1111"],
  I: ["11111", "00100", "00100", "00100", "00100", "11111"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001"],
  E: ["1111", "1000", "1110", "1000", "1000", "1111"],
  U: ["10001", "10001", "10001", "10001", "10001", "01110"],
  M: ["10001", "10001", "11011", "10101", "10001", "10001"],
  D: ["1110", "1001", "1001", "1001", "1001", "1110"],
  "2": ["1110", "0001", "0001", "0110", "1000", "1111"],
  "0": ["01110", "10001", "10001", "10001", "10001", "01110"],
  "6": ["0111", "1000", "1000", "1110", "1001", "0110"],
};

type Kind = { bg: string; ink: string; shape: "round" | "chamfer" };

// Цвета обложки. Скруглённые плитки — с полной обводкой; плитки со срезанными
// углами (ARCHITECTURE, 2026) — обводка только сверху, справа и снизу, как на обложке.
const KINDS: Record<string, Kind> = {
  port: { bg: "transparent", ink: "#e9e9ed", shape: "round" },
  arch: { bg: "#3f2d3b", ink: "#c08aa5", shape: "chamfer" },
  umid: { bg: "#3a2f2c", ink: "#b39373", shape: "round" },
  year: { bg: "#1e2a3e", ink: "#7d95bf", shape: "chamfer" },
};

const CUT = 24;
const CHAMFER = [
  `polygon(0 0, ${100 - CUT}% 0, 100% ${CUT}%, 100% 100%, ${CUT}% 100%, 0 ${100 - CUT}%)`, // срез справа-сверху и слева-снизу
  `polygon(${CUT}% 0, 100% 0, 100% ${100 - CUT}%, ${100 - CUT}% 100%, 0 100%, 0 ${CUT}%)`, // срез слева-сверху и справа-снизу
];

function tileShape(k: Kind, row: number): CSSProperties {
  if (k.shape === "round") {
    return { background: k.bg, border: `1.5px solid ${k.ink}`, borderRadius: "30%" };
  }
  const line = `linear-gradient(${k.ink},${k.ink})`;
  return {
    clipPath: CHAMFER[row % 2],
    background: `${line} top / 100% 1.5px no-repeat, ${line} right / 1.5px 100% no-repeat, ${line} bottom / 100% 1.5px no-repeat, ${k.bg}`,
  };
}

interface Tile {
  ch: string;
  c: number;
  r: number;
  k: string;
  i: number;
}

// Сетка: колонки 0..10, строки 0..11. PORTFOLIO — ряд 4, ARCHITECTURE — колонка 7,
// 2026 — колонка 1, UMID — ряд 9.
function layout(): Tile[] {
  const t: Tile[] = [];
  let i = 0;
  "PORTFOLIO".split("").forEach((ch, c) => t.push({ ch, c, r: 4, k: "port", i: i++ }));
  "ARCHITECTURE".split("").forEach((ch, r) => {
    if (r === 4) return;
    t.push({ ch, c: 7, r, k: r === 9 ? "umid" : "arch", i: i++ });
  });
  "2026".split("").forEach((ch, r) => {
    if (r === 1) return;
    t.push({ ch, c: 1, r: r + 3, k: "year", i: i++ });
  });
  "MID".split("").forEach((ch, c) => t.push({ ch, c: 8 + c, r: 9, k: "umid", i: i++ }));
  return t;
}

const TILES = layout();

type Scatter = { sx: number; sy: number; sr: number };
type Phase = "initial" | "scattered" | "settled";

interface IntroProps {
  /** Множитель скорости слёта плиток (0.4 — медленно, 2.5 — быстро). */
  speed?: number;
  showScrollHint?: boolean;
}

export default function Intro({ speed = 1, showScrollHint = true }: IntroProps) {
  const [phase, setPhase] = useState<Phase>("initial");
  const [scatter, setScatter] = useState<Scatter[] | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase("settled");
      return;
    }
    setScatter(
      TILES.map(() => ({
        sx: (Math.random() - 0.5) * 140,
        sy: (Math.random() - 0.5) * 140,
        sr: (Math.random() - 0.5) * 220,
      })),
    );
    setPhase("scattered");
    const t = setTimeout(() => setPhase("settled"), 60);
    return () => clearTimeout(t);
  }, []);

  const settled = phase === "settled";
  const animate = scatter !== null;

  return (
    <section className={styles.intro} aria-label="Обложка портфолио">
      <div className={styles.board}>
        {TILES.map((t) => {
          const k = KINDS[t.k];
          const delay = (t.i * 0.055) / speed;
          const dur = 1.15 / speed;
          const g = GLYPHS[t.ch];
          const w = g[0].length;
          const s = scatter?.[t.i];

          const style: CSSProperties = {
            left: `calc(${t.c} * var(--u) * 1.1)`,
            top: `calc(${t.r} * var(--u) * 1.1)`,
            ...tileShape(k, t.r),
            opacity: settled ? 1 : 0,
            transform:
              settled || !s
                ? "translate(0,0) rotate(0deg) scale(1)"
                : `translate(${s.sx}vw, ${s.sy}vh) rotate(${s.sr}deg) scale(.5)`,
            transition:
              settled && animate
                ? `transform ${dur}s var(--ease-out) ${delay}s, opacity ${dur * 0.5}s ease ${delay}s`
                : "none",
          };

          return (
            <div key={t.i} className={styles.tile} style={style}>
              <div
                className={styles.glyph}
                style={{
                  width: `calc(var(--u) * 0.112 * ${w})`,
                  gridTemplateColumns: `repeat(${w},1fr)`,
                  ["--ink" as string]: k.ink,
                }}
              >
                {g.flatMap((row, r) =>
                  row.split("").map((v, c) =>
                    v === "1" ? (
                      <span
                        key={`${r}-${c}`}
                        className={styles.mark}
                        style={{ gridColumn: c + 1, gridRow: r + 1 }}
                      />
                    ) : null,
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
      {showScrollHint && (
        <a href="#resume" className={styles.hint}>
          <span>Резюме</span>
          <span className={styles.hintLine} />
        </a>
      )}
    </section>
  );
}
