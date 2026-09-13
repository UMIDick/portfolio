import type { Resume as ResumeData } from "@/lib/types";
import ToolCards from "./ToolCards";
import Stagger from "./Stagger";
import styles from "./Resume.module.css";

export default function Resume({ resume }: { resume: ResumeData }) {
  return (
    <section id="resume" className={styles.section} aria-labelledby="resume-title">
      <div className={`${styles.head} rise`}>
        <div className="kicker">Резюме</div>
        <h1 id="resume-title" className="h1">
          {resume.name}
        </h1>
        <p className="lead" style={{ fontSize: 24 }}>
          {resume.tagline}
        </p>
      </div>

      <Stagger className={styles.grid}>
        <div className={styles.col}>
          <h2 className={styles.label}>Образование</h2>
          <p className={styles.item}>
            {resume.education.degree}, {resume.education.university}
          </p>
          {resume.education.gpa && <p className={styles.muted}>{resume.education.gpa}</p>}
        </div>

        <div className={styles.col}>
          <h2 className={styles.label}>Опыт</h2>
          {resume.experience.map((e) => (
            <p key={e.role + e.company} className={styles.item}>
              {e.role}
              <br />
              <span className={styles.sub}>{e.company}</span>
            </p>
          ))}
        </div>

        <div className={styles.col}>
          <h2 className={styles.label}>Языки</h2>
          {resume.languages.map((l) => (
            <p key={l.name} className={styles.item}>
              {l.name} — {l.level}
            </p>
          ))}
        </div>
      </Stagger>

      {/* Анимация только на заголовке: анимируемая обёртка над стеклянными
          карточками даёт в Chromium светлые полосы от backdrop-filter. */}
      <div className={styles.tools}>
        <h2 className={`${styles.label} rise`}>Навыки работы в программах</h2>
        <ToolCards tools={resume.tools} />
        {resume.toolsNote && <p className={styles.muted}>{resume.toolsNote}</p>}
      </div>
    </section>
  );
}
