"use client";

import { getImageProps } from "next/image";
import type { CSSProperties } from "react";
import type { Project, Sheet } from "@/lib/types";
import { CAROUSEL_SIZES, EAGER_SLIDES } from "@/lib/sheet-image";
import { WARM_STAGES } from "@/lib/gpu-warm";
import SheetGallery from "./SheetGallery";
import { SheetViewerWarm } from "./SheetViewer";
import page from "@/app/projects/[slug]/page.module.css";

/**
 * Страница проекта «вхолостую» — для прогрева видеокарты (см. GpuWarmup): та же
 * разметка и те же классы, что у app/projects/[slug]/page.tsx (иконка с тенью,
 * текст, стеклянная панель с градиентами и зерном, карусель листов, планшет,
 * блоки соседних проектов), но без ссылок, 3D-макета и имён View Transition.
 * Картинки — с теми же адресами, что запросит настоящая страница (кэш общий).
 * stage — сколько частей показано (WARM_STAGES в lib/gpu-warm): страница появляется
 * постепенно, чтобы видеокарта не была занята подолгу; после них (stage > WARM_STAGES) —
 * ещё и просмотр листа на весь экран (SheetViewerWarm).
 */
export default function WarmPage({
  project,
  lockedSheets,
  stage,
}: {
  project: Project;
  lockedSheets?: Sheet[];
  stage: number;
}) {
  const palette = {
    ["--p-bg" as string]: project.palette.bg,
    ["--p-ink" as string]: project.palette.ink,
  } as CSSProperties;
  const icon = getImageProps({
    src: project.icon.dark,
    alt: "",
    fill: true,
    sizes: "(max-width: 760px) 100vw, 320px",
  }).props;
  const cover =
    project.cover &&
    getImageProps({
      src: project.cover.src,
      alt: "",
      width: project.cover.width,
      height: project.cover.height,
      sizes: "(max-width: 1240px) 100vw, 1100px",
    }).props;

  const sheet = project.sheets[0];
  const sheetImg =
    sheet &&
    getImageProps({ src: sheet.src, alt: "", width: sheet.width, height: sheet.height, sizes: CAROUSEL_SIZES }).props;

  return (
    <div className="gpu-warm-page" style={palette}>
      <div className={`${page.screen} ${page.screen1}`}>
        <header className={`${page.top} container`}>
          <span className={page.back}>← Портфолио</span>
          <nav className={page.topNav}>
            <span className={page.topLink}>← Проект</span>
            <span className={page.topLink}>Проект →</span>
          </nav>
        </header>
        <div className={`${page.firstScreen} container`}>
          <section className={page.hero}>
            <div className={page.coverStage} data-warm-stage>
              <div className={`${page.cover} rise`} data-warm-icon>
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img {...icon} loading="eager" />
              </div>
            </div>
            <div className={`${page.heroText} rise rise-2`}>
              <div className="kicker">Проект · {project.kind}</div>
              <h1 className="h1">{project.title}</h1>
              <p className="lead">{project.description}</p>
              <dl className={page.meta}>
                <div>
                  <dt>Листы</dt>
                  <dd>1–25</dd>
                </div>
                <div>
                  <dt>Формат</dt>
                  <dd>А3, альбомная</dd>
                </div>
              </dl>
            </div>
          </section>
          {stage >= 2 && (
            <section className={page.sheetsSection} data-sheets-panel>
              <p className={`${page.sheetsHint} rise`}>(крутите колесо над лентой, чтобы листать)</p>
              {stage >= 3 && (
                <SheetGallery sheets={project.sheets.slice(0, EAGER_SLIDES + 1)} projectTitle="" layout="carousel" />
              )}
            </section>
          )}
        </div>
      </div>
      {/* Второй экран настоящей страницы тоже попадает в снимок перехода */}
      <div className={`${page.board} gpu-warm-board`} style={stage < 4 ? { display: "none" } : undefined}>
        {cover && (
          <span className={page.poster}>
            {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
            <img {...cover} loading="eager" />
          </span>
        )}
        <nav className={page.neighbours}>
          <span className={page.neighbour}>
            <span className={page.neighbourKicker}>← Предыдущий проект</span>
            <span className={page.neighbourTitle}>{project.title}</span>
            <span className={page.neighbourKind}>{project.kind}</span>
          </span>
          <p className={page.copy}>© {project.title}</p>
          <span className={`${page.neighbour} ${page.neighbourRight}`}>
            <span className={page.neighbourKicker}>Следующий проект →</span>
            <span className={page.neighbourTitle}>{project.title}</span>
            <span className={page.neighbourKind}>{project.kind}</span>
          </span>
        </nav>
      </div>
      {/* Заблокированная лента (чертежи ещё не готовы, underConstruction): её листы
          (SVG-заглушки с текстом и рамками) растрируются под размытием — ~11 своих программ
          по 35–55 мс, иначе они компилировались, пока листы въезжают. Отдельным слоем у верха
          окна: то, что ниже края слоя, браузер не растрирует */}
      {stage >= 3 && lockedSheets?.length ? (
        <section className={`${page.sheetsSection} gpu-warm-locked`}>
          <SheetGallery sheets={lockedSheets} projectTitle="" layout="carousel" locked="…" />
        </section>
      ) : null}
      {stage > WARM_STAGES && sheetImg && (
        <SheetViewerWarm src={sheet.src} thumb={sheetImg.src} width={sheet.width} height={sheet.height} />
      )}
    </div>
  );
}
