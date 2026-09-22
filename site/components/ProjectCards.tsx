import Image, { getImageProps } from "next/image";
import Link from "next/link";
import type { Project } from "@/lib/types";
import { CAROUSEL_SIZES, EAGER_SLIDES, isUnoptimized } from "@/lib/sheet-image";
import Stagger from "./Stagger";
import ModelPreload from "./ModelPreload";
import { NAV, ProjectIcon } from "./SheetTransition";
import styles from "./ProjectCards.module.css";

interface Props {
  projects: Project[];
  heading: string;
  lead: string;
  /** Копия «вхолостую» для прогрева видеокарты (GpuWarmup): без id, ссылок, имён перехода и подготовки макетов. */
  warm?: boolean;
}

/** Что готовить заранее для страницы проекта: 3D-макет и первые листы карусели. */
function preloadSource(p: Project) {
  return {
    slug: p.slug,
    icon: p.icon.dark,
    ink: p.palette.ink,
    bg: p.palette.bg,
    // Те же адреса, что запросит карусель (next/image), — тогда сработает кэш
    sheets: p.sheets.slice(0, EAGER_SLIDES).map((s) => {
      const { props } = getImageProps({
        src: s.src,
        alt: "",
        width: s.width,
        height: s.height,
        sizes: CAROUSEL_SIZES,
        unoptimized: isUnoptimized(s.src),
      });
      return { src: props.src, srcSet: props.srcSet, sizes: props.sizes, ratio: s.height / s.width };
    }),
  };
}

export default function ProjectCards({ projects, heading, lead, warm = false }: Props) {
  const icons = (p: Project) => (
    <div className={styles.icon}>
      <Image src={p.icon.dark} alt="" fill sizes="(max-width: 700px) 100vw, 360px" />
      <Image src={p.icon.light} alt="" fill sizes="(max-width: 700px) 100vw, 360px" className={styles.light} />
    </div>
  );
  if (warm)
    return (
      <section className={`${styles.section} page`}>
        <Stagger className={styles.reveal} busyMs={5600}>
          <div className={styles.head}>
            <div className={styles.title}>
              <h2 className="h2">{heading}</h2>
              <span className={styles.bar} aria-hidden="true" />
              <div className="kicker">Проекты</div>
            </div>
            <p className="lead">{lead}</p>
          </div>
          <div className={styles.grid}>
            {projects.map((p) => (
              <div key={p.slug} className={styles.card}>
                {icons(p)}
              </div>
            ))}
          </div>
        </Stagger>
      </section>
    );

  return (
    <section id="projects" className={`${styles.section} page`} aria-labelledby="projects-title" data-screen>
      {/* busyMs: шапка 0,8 с + карточки до 5,3 с — фоновая подготовка в каскад не попадает */}
      <Stagger className={styles.reveal} skipAfter="proj-close" once="projects" busyMs={5600}>
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
            <Link
              key={p.slug}
              href={`/projects/${p.slug}`}
              transitionTypes={NAV.open}
              data-nav="proj-open"
              className={styles.card}
              aria-label={p.title}
            >
              <ProjectIcon slug={p.slug}>{icons(p)}</ProjectIcon>
            </Link>
          ))}
        </div>

        {/* 3D-макеты и первые листы проектов готовятся заранее — переход к проекту без задержек */}
        <ModelPreload models={projects.map(preloadSource)} />
      </Stagger>
    </section>
  );
}
