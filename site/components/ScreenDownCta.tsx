"use client";

import { useEffect, useState } from "react";
import styles from "./Cta.module.css";

/**
 * Плавающая кнопка «к следующему экрану» на странице проекта — та же, что на главной
 * (NextCta, стили Cta.module.css), но без привязки к каскадам разделов: видна, пока
 * текущий экран (пересекает середину окна) не последний, и ведёт к следующему.
 * Сам переход — ScreenPager (перехватывает ссылки-якоря на экраны).
 * Кнопка стоит вне экранов: position: fixed внутри секции ломается от их анимаций.
 */
export default function ScreenDownCta({ label, delay = "1.2s" }: { label: string; delay?: string }) {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    const screens = Array.from(document.querySelectorAll<HTMLElement>("main [data-screen]")).filter(
      (el) => !el.closest(".gpu-warm"),
    );
    const io = new IntersectionObserver(
      (entries) => {
        const cur = entries.find((e) => e.isIntersecting)?.target;
        if (!cur) return;
        const next = screens[screens.indexOf(cur as HTMLElement) + 1];
        setTarget(next?.id || null);
      },
      // Текущий экран — тот, что пересекает середину окна
      { rootMargin: "-50% 0px -50% 0px" },
    );
    screens.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  const shown = target !== null;
  return (
    <a
      href={target ? `#${target}` : "#"}
      className={styles.cta}
      data-hidden={shown ? undefined : ""}
      aria-label={label}
      aria-hidden={shown ? undefined : true}
      tabIndex={shown ? undefined : -1}
    >
      {/* Первый выход — тем же прыжком, что на главной, когда страница уже раскрылась */}
      <span className={styles.ctaBody} data-enter="" style={{ animationDelay: delay }}>
        <svg className={styles.ctaArrow} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 5v14M6 13l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </a>
  );
}
