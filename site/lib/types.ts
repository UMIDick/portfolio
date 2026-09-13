/**
 * Модель контента сайта.
 *
 * Сейчас данные лежат в `content/*.json`. Когда появится админка и backend,
 * эти же типы станут контрактом API: страницы работают только через
 * функции из `lib/content.ts` и не знают, откуда приходят данные.
 */

export interface Education {
  degree: string;
  university: string;
  gpa?: string;
}

export interface Experience {
  role: string;
  company: string;
}

export interface Tool {
  name: string;
  /** Уровень владения, 1–5 — закрашенные точки на карточке. */
  level: number;
  /** Для каких задач используется; если есть — карточка раскрывается по клику. */
  description?: string;
}

export interface Language {
  name: string;
  level: string;
}

export interface Contacts {
  telegram: { handle: string; url: string };
  email: string;
}

export interface Resume {
  name: string;
  /** Специализация и город — подзаголовок под именем. */
  tagline: string;
  education: Education;
  experience: Experience[];
  tools: Tool[];
  /** Примечание под инструментами, например «Знаком с BIM». */
  toolsNote?: string;
  languages: Language[];
}

export interface Site {
  /** Заголовок вкладки и og:title. */
  title: string;
  description: string;
  /** Год в подписи «© 2026 …». */
  year: number;
  resume: Resume;
  contacts: Contacts;
  /** Тексты блока «Проекты» на главной. */
  projectsIntro: { heading: string; lead: string };
}

export interface Sheet {
  /** Номер листа в комплекте (сквозная нумерация по ТЗ). */
  number: number;
  title: string;
  /** Путь к изображению листа (А3, альбомная). */
  src: string;
  width: number;
  height: number;
}

export interface Project {
  slug: string;
  title: string;
  /** Короткая подпись типа объекта, например «Жилой интерьер». */
  kind: string;
  description: string;
  /** Иконки-обложки в двух темах (квадратные). */
  icon: { dark: string; light: string };
  /** Цвета карточки/страницы проекта из палитры обложки. */
  palette: { bg: string; ink: string };
  /** Диапазон номеров листов, как в ТЗ заказчика. */
  sheetRange: [number, number];
  sheets: Sheet[];
}
