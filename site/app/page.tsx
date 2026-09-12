import Intro from "@/components/Intro";
import Resume from "@/components/Resume";
import ProjectCards from "@/components/ProjectCards";
import Contacts from "@/components/Contacts";
import { getProjects, getSite } from "@/lib/content";

export default async function HomePage() {
  const [site, projects] = await Promise.all([getSite(), getProjects()]);

  return (
    <>
      <Intro />
      <main className="container" style={{ paddingBottom: 64 }}>
        <Resume resume={site.resume} />
        <div className="divider" />
        <ProjectCards
          projects={projects}
          heading={site.projectsIntro.heading}
          lead={site.projectsIntro.lead}
        />
        <div className="divider" />
        <Contacts contacts={site.contacts} year={site.year} name={site.resume.name} />
      </main>
    </>
  );
}
