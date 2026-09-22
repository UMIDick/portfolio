import Intro from "@/components/Intro";
import Resume from "@/components/Resume";
import ProjectCards from "@/components/ProjectCards";
import Contacts from "@/components/Contacts";
import NextCta from "@/components/NextCta";
import GpuWarmup from "@/components/GpuWarmup";
import { PageSheet } from "@/components/SheetTransition";
import { getProjects, getSite } from "@/lib/content";

export default async function HomePage() {
  const [site, projects] = await Promise.all([getSite(), getProjects()]);

  return (
    <PageSheet kind="home">
      <Intro />
      <main className="container" data-home>
        <Resume resume={site.resume} />
        <ProjectCards
          projects={projects}
          heading={site.projectsIntro.heading}
          lead={site.projectsIntro.lead}
        />
        <Contacts contacts={site.contacts} year={site.year} name={site.resume.name} />
      </main>
      {/* Кнопка со стрелкой к следующему экрану — одна на все разделы, при перелистывании не пропадает */}
      <NextCta labels={{ projects: "Проекты", contacts: "Связь" }} />
      {/* Шейдеры эффектов перехода компилируются заранее, в простое, — первый переход без рывков */}
      <GpuWarmup
        project={projects[0]}
        lockedSheets={projects.find((p) => p.underConstruction)?.sheets.slice(0, 2)}
        resume={<Resume resume={site.resume} warm />}
        projects={
          <ProjectCards projects={projects} heading={site.projectsIntro.heading} lead={site.projectsIntro.lead} warm />
        }
      />
    </PageSheet>
  );
}
