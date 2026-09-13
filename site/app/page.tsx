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
      <main className="container">
        <Resume resume={site.resume} />
        <ProjectCards
          projects={projects}
          heading={site.projectsIntro.heading}
          lead={site.projectsIntro.lead}
        />
        <Contacts contacts={site.contacts} year={site.year} name={site.resume.name} />
      </main>
    </>
  );
}
