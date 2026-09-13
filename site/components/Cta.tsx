import styles from "./Cta.module.css";

/* Плавающая кнопка перехода к следующему разделу — круг со стрелкой, название
   раздела только для скринридеров. Ставится внутрь Stagger: появляется через
   `delay` после старта каскада и видна, пока раздел на экране. */
export default function Cta({ href, label, delay }: { href: string; label: string; delay: string }) {
  return (
    <a
      href={href}
      className={styles.cta}
      style={{ "--cta-delay": delay } as React.CSSProperties}
      aria-label={label}
    >
      <span className={styles.ctaBody}>
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
