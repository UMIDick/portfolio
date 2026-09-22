import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import ProjectCover from "@/components/ProjectCover";
import ProjectModel from "@/components/ProjectModel";
import SheetGallery from "@/components/SheetGallery";
import NeighbourCascade from "@/components/NeighbourCascade";
import ScreenDownCta from "@/components/ScreenDownCta";
import { NAV, PageSheet, ProjectIcon } from "@/components/SheetTransition";
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
    <PageSheet kind="project">
      <main className={styles.page} style={palette}>
        <div className={`${styles.screen} ${styles.screen1}`} data-screen>
          <header className={`${styles.top} container`} data-cascade-item style={{ ["--ci" as string]: 0 }}>
            <Link href="/#projects" transitionTypes={NAV.close} data-nav="proj-close" className={styles.back}>
              <span aria-hidden="true">←</span> Портфолио
            </Link>
            <nav className={styles.topNav} aria-label="Соседние проекты">
              {prev && (
                <Link href={`/projects/${prev.slug}`} transitionTypes={NAV.prev} data-nav="proj-prev" className={styles.topLink}>
                  <span aria-hidden="true">←</span> {prev.title}
                </Link>
              )}
              {next && (
                <Link href={`/projects/${next.slug}`} transitionTypes={NAV.next} data-nav="proj-next" className={styles.topLink}>
                  {next.title} <span aria-hidden="true">→</span>
                </Link>
              )}
            </nav>
          </header>

          <div className={`${styles.firstScreen} container`}>
            <section className={styles.hero}>
              {/* Иконка проекта; поверх неё после перехода — 3D-макет (ProjectModel) */}
              <div className={styles.coverStage} data-cascade-item style={{ ["--ci" as string]: 1 }}>
                <ProjectIcon slug={project.slug}>
                  <div className={`${styles.cover} rise`}>
                    <Image src={project.icon.dark} alt="" fill priority sizes="(max-width: 760px) 100vw, 320px" />
                  </div>
                </ProjectIcon>
                <ProjectModel
                  slug={project.slug}
                  icon={project.icon.dark}
                  ink={project.palette.ink}
                  bg={project.palette.bg}
                  preload={[next, prev]
                    .filter((p) => p !== null && p !== undefined)
                    .map((p) => ({ slug: p.slug, icon: p.icon.dark, ink: p.palette.ink, bg: p.palette.bg }))}
                />
              </div>
              <div className={`${styles.heroText} rise rise-2`} data-cascade-item style={{ ["--ci" as string]: 2 }}>
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

            <section className={styles.sheetsSection} aria-label="Листы проекта" data-sheets-panel data-cascade-item style={{ ["--ci" as string]: 3 }}>
              {!project.underConstruction && (
                <p className={`${styles.sheetsHint} rise`}>
                  (крутите колесо над лентой, чтобы листать; нажмите на лист, чтобы открыть его во весь экран)
                </p>
              )}
              {count > 0 ? (
                <SheetGallery
                  sheets={project.sheets}
                  projectTitle={project.title}
                  layout="carousel"
                  locked={project.underConstruction ? "still under construction" : undefined}
                />
              ) : (
                <p className="lead">Чертежи этого проекта ещё не загружены.</p>
              )}
            </section>
          </div>
        </div>

        {/* Второй экран: планшет проекта и переходы к соседним проектам на общей сетке */}
        <section
          id="overview"
          data-screen
          className={`${styles.screen} ${styles.screen2}`}
          aria-label="Обложка проекта и другие проекты"
          style={project.cover ? { ["--cover-ratio" as string]: project.cover.width / project.cover.height } : undefined}
        >
          <div className={`${styles.board} container`}>
            <div className={styles.posterWrap} data-cascade-item style={{ ["--ci" as string]: 4 }}>
            {project.cover && (
              <ProjectCover
                cover={project.cover}
                projectTitle={project.title}
                className={`${styles.poster} rise`}
              />
            )}
            </div>

            <nav className={styles.neighbours} aria-label="Другие проекты" data-cascade-item style={{ ["--ci" as string]: 5 }}>
              {prev ? (
                <Link href={`/projects/${prev.slug}`} transitionTypes={NAV.prev} data-nav="proj-prev" className={`${styles.neighbour} rise`}>
                  <span className={styles.neighbourKicker}>← Предыдущий проект</span>
                  <span className={styles.neighbourTitle}>{prev.title}</span>
                  <span className={styles.neighbourKind}>{prev.kind}</span>
                </Link>
              ) : (
                <span />
              )}
              <p className={styles.copy}>
                © {site.year} {site.resume.name}
              </p>
              {next ? (
                <Link
                  href={`/projects/${next.slug}`}
                  transitionTypes={NAV.next}
                  data-nav="proj-next"
                  className={`${styles.neighbour} rise`}
                >
                  <span className={styles.neighbourKicker}>Следующий проект →</span>
                  <span className={styles.neighbourTitle}>{next.title}</span>
                  <span className={styles.neighbourKind}>{next.kind}</span>
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </div>
        </section>
        <NeighbourCascade />
        <ScreenDownCta label="Планшет проекта" upCta={slug === "tower"} />
      </main>
    </PageSheet>
  );
}
