import Image from "next/image";
import type { Tool } from "@/lib/types";
import styles from "./ToolCards.module.css";

type Mark = {
  /** Монограмма-заменитель, если файла логотипа ещё нет. */
  mark: string;
  /** Акцентный цвет бренда: точки уровня и подсветка карточки. */
  color: string;
  icon?: string;
  /** Логотип сам является плиткой с фоном (Adobe, Enscape, D5) — без подложки. */
  solid?: boolean;
  /** Свой цвет подложки — для тёмных логотипов, которым нужен светлый фон. */
  plate?: string;
};

/**
 * Логотипы лежат в `public/icons/tools/`: официальные файлы, обрезанные до
 * иконки. Чтобы добавить программу, достаточно строки здесь и SVG в той папке;
 * пропорции логотипа сохраняются (`object-fit: contain`), растяжения нет.
 */
const MARKS: Record<string, Mark> = {
  autocad: { mark: "A", color: "#e51050", icon: "/icons/tools/autocad.svg" },
  revit: { mark: "R", color: "#1a6afe", icon: "/icons/tools/revit.svg" },
  "3dsmax": { mark: "3", color: "#39a5cc", icon: "/icons/tools/3dsmax.svg" },
  enscape: { mark: "E", color: "#f7941d", icon: "/icons/tools/enscape.svg", solid: true },
  lumion: { mark: "L", color: "#b8d6ed", icon: "/icons/tools/lumion.svg", plate: "#eeeff1" },
  d5: { mark: "D5", color: "#8a3cff", icon: "/icons/tools/d5.svg", solid: true },
  photoshop: { mark: "Ps", color: "#31a8ff", icon: "/icons/tools/photoshop.svg", solid: true },
  illustrator: { mark: "Ai", color: "#ff9a00", icon: "/icons/tools/illustrator.svg", solid: true },
  sketchup: { mark: "Su", color: "#d6453c" },
  archicad: { mark: "Ac", color: "#2f9e6b" },
};

const LEVELS = 5;

function markFor(name: string): Mark {
  const key = name.toLowerCase().replace(/[\s.-]/g, "");
  return MARKS[key] ?? { mark: name.slice(0, 2), color: "var(--color-accent-400)" };
}

export default function ToolCards({ tools }: { tools: Tool[] }) {
  return (
    <ul className={styles.grid}>
      {tools.map((t) => {
        const { mark, color, icon, solid, plate } = markFor(t.name);
        return (
          <li
            key={t.name}
            className={styles.card}
            style={{ "--brand": color, "--plate": plate } as React.CSSProperties}
          >
            {icon ? (
              <span
                className={`${styles.logo} ${solid ? styles.solid : ""} ${plate ? styles.plated : ""}`}
              >
                <Image src={icon} alt="" width={48} height={48} aria-hidden="true" />
              </span>
            ) : (
              <span className={`${styles.logo} ${styles.mark}`} aria-hidden="true">
                {mark}
              </span>
            )}
            <span className={styles.name}>{t.name}</span>
            <span className={styles.dots} role="img" aria-label={`уровень ${t.level} из ${LEVELS}`}>
              {Array.from({ length: LEVELS }, (_, i) => (
                <span key={i} className={i < t.level ? styles.dotOn : styles.dot} />
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
