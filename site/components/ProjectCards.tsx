import Image from "next/image";
import Link from "next/link";
import type { Project } from "@/lib/types";
import styles from "./ProjectCards.module.css";

interface Props {
  projects: Project[];
  heading: string;
  lead: string;
}

export default function ProjectCards({ projects, heading, lead }: Props) {
  return (
    <section id="projects" className={styles.section} aria-labelledby="projects-title">
      <div className={`${styles.head} rise`}>
        <div className="kicker">Проекты</div>
        <h2 id="projects-title" className="h2">
          {heading}
        </h2>
        <p className="lead" style={{ maxWidth: "56ch" }}>
          {lead}
        </p>
      </div>

      <div className={styles.grid}>
        {projects.map((p, i) => (
          <Link
            key={p.slug}
            href={`/projects/${p.slug}`}
            className={`${styles.card} rise`}
            style={{ animationRange: `entry ${i * 10}% entry ${45 + i * 10}%` }}
            aria-label={p.title}
          >
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
    </section>
  );
}
