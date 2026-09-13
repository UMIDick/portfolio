import type { Contacts as ContactsData } from "@/lib/types";
import Stagger from "./Stagger";
import styles from "./Contacts.module.css";

export default function Contacts({ contacts, year, name }: { contacts: ContactsData; year: number; name: string }) {
  return (
    <section id="contacts" className={`${styles.section} page`} aria-labelledby="contacts-title">
      {/* Раздел последний и невысокий — его верх виден ещё с проектов, поэтому
          каскад стартует, когда шапка поднялась в верхнюю треть экрана (или
          страница докручена до конца), а не когда блок лишь выглядывает снизу. */}
      <Stagger className={styles.reveal} edge={0.35}>
        {/* Шапка «выскакивает» первой, затем обе карточки одновременно. */}
        <div className={styles.head}>
          <div className="kicker">Контакты</div>
          <h2 id="contacts-title" className="h2">
            Связаться
          </h2>
        </div>

        <div className={styles.cards}>
          <a
            href={contacts.telegram.url}
            target="_blank"
            rel="noopener"
            className={`${styles.card} ${styles.telegram}`}
          >
            <span className={styles.strip}>Telegram</span>
            <span className={styles.body}>
              <span className={styles.plane} aria-hidden="true" />
              <span className={styles.label}>{contacts.telegram.handle}</span>
            </span>
          </a>

          <a href={`mailto:${contacts.email}`} className={`${styles.card} ${styles.email}`}>
            <span className={styles.strip}>Email</span>
            <span className={styles.body}>
              <svg viewBox="0 0 52 40" className={styles.envelope} fill="currentColor" aria-hidden="true">
                <path fillOpacity=".55" d="M12 40H4c-2.2 0-4-1.8-4-4V12l12 9z" />
                <path fillOpacity=".55" d="M40 40h8c2.2 0 4-1.8 4-4V12l-12 9z" />
                <path fillOpacity=".72" d="M40 21l12-9V6c0-4.5-5.1-7-8.7-4.3L40 4.4z" />
                <path fillOpacity=".72" d="M12 21L0 12V6c0-4.5 5.1-7 8.7-4.3L12 4.4z" />
                <path d="M12 21l14 10.5L40 21V4.4L26 15 12 4.4z" />
              </svg>
              <span className={styles.label}>{contacts.email}</span>
            </span>
          </a>
        </div>
      </Stagger>

      <p className={`${styles.copy} rise`}>
        © {year} {name}
      </p>
    </section>
  );
}
