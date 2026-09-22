"use client";

import { useEffect, useState } from "react";
import styles from "./Cta.module.css";

/** Кнопка уже появлялась (до перезагрузки страницы): дальше она на месте сразу, без ожидания каскада. */
let everShown = false;

/**
 * Плавающая кнопка «к следующему экрану» — одна на всю главную. Раньше у каждого раздела
 * была своя: при перелистывании колесом кнопка раздела пряталась, а следующая появлялась
 * только после каскада своего раздела (у проектов — через 7 с) — заказчик просил, чтобы
 * кнопка не исчезала и не «загружалась» заново.
 * Впервые появляется, когда доиграл каскад раздела, на котором стоит посетитель
 * (`--cards-done` и `data-reveal-at` у обёртки Stagger); после этого видна на всех экранах,
 * у которых есть следующий (кроме обложки — там своя кнопка «Резюме»), и ведёт к нему.
 * Текущий экран — тот, чей Stagger отмечен `data-visible` (пересекает середину окна).
 * Сам переход — ScreenPager (перехватывает ссылки-якоря на экраны).
 */
export default function NextCta({ labels }: { labels: Record<string, string> }) {
  const [target, setTarget] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [enter, setEnter] = useState(false);

  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      const stagger = Array.from(document.querySelectorAll<HTMLElement>("[data-stagger][data-visible]")).find(
        (el) => !el.closest(".gpu-warm"),
      );
      const screen = stagger?.closest("[data-screen]");
      const screens = Array.from(document.querySelectorAll("[data-screen]"));
      const next = screen ? screens[screens.indexOf(screen) + 1] : null;
      if (!stagger || !next?.id) {
        setShown(false);
        return;
      }
      setTarget(next.id);
      if (!everShown) {
        const reveal = stagger.dataset.reveal;
        if (reveal === "pending") return;
        if (reveal === "in") {
          // --cards-done бывает цепочкой calc() — в секунды её пересчитывает сам браузер
          const probe = document.createElement("i");
          probe.style.cssText = "display:none;animation-delay:var(--cards-done,0s)";
          stagger.append(probe);
          const delay = parseFloat(getComputedStyle(probe).animationDelay) * 1000 || 0;
          probe.remove();
          const left = Number(stagger.dataset.revealAt ?? 0) + delay - performance.now();
          if (left > 0) {
            timer = window.setTimeout(update, left + 20);
            return;
          }
        }
        everShown = true;
        setEnter(true);
      }
      setShown(true);
    };

    const mo = new MutationObserver(update);
    for (const el of document.querySelectorAll("[data-stagger]")) {
      mo.observe(el, { attributes: true, attributeFilter: ["data-visible", "data-reveal"] });
    }
    update();
    return () => {
      clearTimeout(timer);
      mo.disconnect();
    };
  }, []);

  return (
    <a
      href={target ? `#${target}` : "#"}
      className={styles.cta}
      data-hidden={shown ? undefined : ""}
      aria-label={target ? labels[target] : undefined}
      aria-hidden={shown ? undefined : true}
      tabIndex={shown ? undefined : -1}
    >
      <span className={styles.ctaBody} data-enter={enter ? "" : undefined}>
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
