# Портфолио — Умид Шамсиддинов (сайт)

Next.js 16 (App Router, React 19, TypeScript). Главная и страницы трёх проектов
пререндерятся статически, JS на клиенте — только интро-анимация и просмотрщик листов.

## Запуск

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # прод-сборка (включает проверку типов)
npm start        # запуск собранного сайта
```

Node.js 20+. Скрипты `npm run typecheck` и `npm run placeholders` — см. ниже.

## Структура

```
app/
  layout.tsx              метаданные сайта, подключение globals.css
  page.tsx                главная: Intro → Resume → ProjectCards → Contacts
  not-found.tsx           404
  projects/[slug]/        страница проекта (обложка, описание, сетка листов, соседние проекты)
components/
  Intro.tsx               обложка из плиток (клиентский компонент, слёт плиток из хаоса)
  Resume.tsx              резюме
  ProjectCards.tsx        три карточки-ссылки на проекты
  Contacts.tsx            карточки Telegram / Email
  SheetGallery.tsx        сетка листов + полноэкранный просмотр (<dialog>, стрелки, свайп, #sheet-N)
content/
  site.json               резюме, контакты, тексты главной
  projects.json           три проекта (без листов)
  sheets/<slug>.json      список листов каждого проекта
lib/
  types.ts                типы контента — контракт для будущего backend/админки
  content.ts              единственная точка чтения контента (сейчас — JSON с диска)
public/
  fonts/GOST_A.ttf        шрифт GOST Type A
  icons/                  иконки проектов (dark/light), маска логотипа Telegram
  projects/<slug>/sheets/ изображения листов А3
scripts/
  make-placeholders.mjs   генерирует листы-заглушки и content/sheets/*.json
```

## Контент и будущая админка

Страницы получают данные **только** через `lib/content.ts` (`getSite`, `getProjects`,
`getProject`). Функции асинхронные, поэтому переход на базу данных или API сводится
к замене их реализации; типы в `lib/types.ts` — готовый контракт.

Когда появится админка:

- вместо JSON читать из БД, изображения листов отдавать из хранилища;
- страницы сейчас статические (`generateStaticParams`, `dynamicParams = false`) —
  после правки контента вызывать `revalidatePath('/')` и `revalidatePath('/projects/<slug>')`
  либо перевести страницы на ISR (`export const revalidate = 60`);
- `dynamicParams` переключить в `true`, если проекты будут добавляться без пересборки.

## Реальные чертежи

Сейчас листы — SVG-заглушки, сгенерированные `npm run placeholders` (нумерация 2–25, 26–40,
41–50 по ТЗ, предварительная). Когда придут настоящие чертежи:

1. Положить файлы (JPG/PNG/WebP, А3 альбомная) в `public/projects/<slug>/sheets/`.
2. Обновить `content/sheets/<slug>.json`: `number`, `title`, `src`, `width`, `height`.
3. Удалить лишние SVG-заглушки.

Обложка проекта сейчас — тёмная иконка из `icon.dark`; отдельное поле под обложку
можно добавить в `Project`, когда заказчик её пришлёт.

## Настройки

- `SITE_URL` (см. `.env.example`) — публичный адрес для Open Graph; без него
  используется `http://localhost:3000`.
- Скорость интро — проп `speed` у `<Intro />` в `app/page.tsx` (по умолчанию 1).

## Дизайн

Дизайн-система Nocturne: токены в `app/globals.css` (подмножество `../ds/styles.css`),
шрифт везде GOST Type A, заголовки не жирнее 500, цвета обложки — переменные `--cover-*`.
Анимации при прокрутке — `animation-timeline: view()` (в Firefox играют один раз при
загрузке); при `prefers-reduced-motion` анимации выключены, плитки интро появляются сразу.
