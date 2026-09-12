import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Project, Sheet, Site } from "./types";

/**
 * Единственная точка доступа к контенту.
 *
 * Сейчас читает JSON из `content/`. Когда появится админка и БД, достаточно
 * заменить реализацию этих функций — страницы и компоненты остаются как есть.
 * Функции async именно поэтому: в будущем здесь будут запросы к базе/API.
 */

const CONTENT_DIR = path.join(process.cwd(), "content");

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(path.join(CONTENT_DIR, file), "utf8");
  return JSON.parse(raw) as T;
}

export async function getSite(): Promise<Site> {
  return readJson<Site>("site.json");
}

type ProjectRecord = Omit<Project, "sheets">;

async function readSheets(slug: string): Promise<Sheet[]> {
  try {
    return await readJson<Sheet[]>(path.join("sheets", `${slug}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function getProjects(): Promise<Project[]> {
  const records = await readJson<ProjectRecord[]>("projects.json");
  return Promise.all(
    records.map(async (p) => ({ ...p, sheets: await readSheets(p.slug) })),
  );
}

export async function getProject(slug: string): Promise<Project | null> {
  const projects = await getProjects();
  return projects.find((p) => p.slug === slug) ?? null;
}

/** Соседние проекты для навигации «предыдущий / следующий» на странице проекта. */
export async function getProjectNeighbours(slug: string): Promise<{
  prev: Project | null;
  next: Project | null;
}> {
  const projects = await getProjects();
  const i = projects.findIndex((p) => p.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: projects[i - 1] ?? null, next: projects[i + 1] ?? null };
}
