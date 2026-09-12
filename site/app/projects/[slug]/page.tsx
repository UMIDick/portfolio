import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import SheetGallery from "@/components/SheetGallery";
import { getProject, getProjectNeighbours, getProjects, getSite } from "@/lib/content";
import styles from "./page.module.css";

export const dynamicParams = false;

export async function generateStaticParams() {
  const projects = await getProjects();
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const project = await getProject(slug);
  if (!project) return {};
  return {
    title: project.title,
    description: project.description,
    openGraph: { title: project.title, description: project.description, images: [project.icon.dark] },
  };
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export default async function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const [project, site, { prev, next }] = await Promise.all([
    getProject(slug),
    getSite(),
    getProjectNeighbours(slug),
  ]);
  if (!project) notFound();

  const [from, to] = project.sheetRange;
  const count = project.sheets.length;
  const palette = {
    ["--p-bg" as string]: project.palette.bg,
    ["--p-ink" as string]: project.palette.ink,
  };

  return (
    <div style={palette}>
      <header className={`${styles.top} container`}>
        <Link href="/#projects" className={styles.back}>
          <span aria-hidden="true">←</span> Портфолио
        </Link>
        <nav className={styles.topNav} aria-label="Соседние проекты">
          {prev && (
            <Link href={`/projects/${prev.slug}`} className={styles.topLink}>
              <span aria-hidden="true">←</span> {prev.title}
            </Link>
          )}
          {next && (
            <Link href={`/projects/${next.slug}`} className={styles.topLink}>
              {next.title} <span aria-hidden="true">→</span>
            </Link>
          )}
        </nav>
      </header>

      <main className="container" style={{ paddingBottom: 64 }}>
        <section className={styles.hero}>
          <div className={`${styles.cover} rise`}>
            <Image src={project.icon.dark} alt="" fill priority sizes="(max-width: 760px) 100vw, 320px" />
          </div>
          <div className={`${styles.heroText} rise rise-2`}>
            <div className="kicker">Проект · {project.kind}</div>
            <h1 className="h1">{project.title}</h1>
            <p className="lead">{project.description}</p>
            <dl className={styles.meta}>
              <div>
                <dt>Листы</dt>
                <dd>
                  {from}–{to}
                </dd>
              </div>
              <div>
                <dt>Всего</dt>
                <dd>
                  {count} {plural(count, "лист", "листа", "листов")}
                </dd>
              </div>
              <div>
                <dt>Формат</dt>
                <dd>А3, альбомная</dd>
              </div>
            </dl>
          </div>
        </section>

        <div className="divider" />

        <section className={styles.sheetsSection} aria-labelledby="sheets-title">
          <div className={`${styles.sheetsHead} rise`}>
            <div className="kicker">Комплект</div>
            <h2 id="sheets-title" className="h2">
              Листы
            </h2>
            <p className="lead">Нажмите на лист, чтобы открыть его во весь экран. Стрелки ← → листают.</p>
          </div>
          {count > 0 ? (
            <SheetGallery sheets={project.sheets} projectTitle={project.title} />
          ) : (
            <p className="lead">Чертежи этого проекта ещё не загружены.</p>
          )}
        </section>

        <div className="divider" />

        <nav className={styles.neighbours} aria-label="Другие проекты">
          {prev ? (
            <Link href={`/projects/${prev.slug}`} className={`${styles.neighbour} rise`}>
              <span className={styles.neighbourKicker}>← Предыдущий проект</span>
              <span className={styles.neighbourTitle}>{prev.title}</span>
              <span className={styles.neighbourKind}>{prev.kind}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/projects/${next.slug}`} className={`${styles.neighbour} ${styles.neighbourRight} rise`}>
              <span className={styles.neighbourKicker}>Следующий проект →</span>
              <span className={styles.neighbourTitle}>{next.title}</span>
              <span className={styles.neighbourKind}>{next.kind}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>

        <p className={styles.copy}>
          © {site.year} {site.resume.name}
        </p>
      </main>
    </div>
  );
}
