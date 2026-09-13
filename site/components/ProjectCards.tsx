import Image from "next/image";
import Link from "next/link";
import type { Project } from "@/lib/types";
import Stagger from "./Stagger";
import Cta from "./Cta";
import styles from "./ProjectCards.module.css";

interface Props {
  projects: Project[];
  heading: string;
  lead: string;
}

export default function ProjectCards({ projects, heading, lead }: Props) {
  return (
    <section id="projects" className={`${styles.section} page`} aria-labelledby="projects-title">
      <Stagger className={styles.reveal}>
        {/* Шапка: заголовок | Проекты — по центру, «выскакивает» первой, как в резюме. */}
        <div className={styles.head}>
          <div className={styles.title}>
            <h2 id="projects-title" className="h2">
              {heading}
            </h2>
            <span className={styles.bar} aria-hidden="true" />
            <div className="kicker">Проекты</div>
          </div>
          <p className="lead">{lead}</p>
        </div>

        {/* Карточки выходят по центру и разъезжаются по местам: квартира → налево,
            дом → направо, школа остаётся в центре (см. ProjectCards.module.css). */}
        <div className={styles.grid}>
          {projects.map((p) => (
            <Link key={p.slug} href={`/projects/${p.slug}`} className={styles.card} aria-label={p.title}>
              <div className={styles.icon}>
                <Image src={p.icon.dark} alt="" fill sizes="(max-width: 700px) 100vw, 360px" />
                <Image
                  src={p.icon.light}
                  alt=""
                  fill
                  sizes="(max-width: 700px) 100vw, 360px"
                  className={styles.light}
                />
              </div>
            </Link>
          ))}
        </div>

        {/* Кнопка к контактам — через пару секунд после того, как школа встала в центр. */}
        <Cta href="#contacts" label="Связь" delay="var(--cards-done)" />
      </Stagger>
    </section>
  );
}
