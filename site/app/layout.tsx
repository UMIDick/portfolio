import type { Metadata, Viewport } from "next";
import { getSite } from "@/lib/content";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const site = await getSite();
  return {
    // Публичный адрес сайта — задать в .env как SITE_URL, когда появится домен
    metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
    title: {
      default: site.title,
      template: `%s — ${site.resume.name}`,
    },
    description: site.description,
    openGraph: {
      title: site.title,
      description: site.description,
      locale: "ru_RU",
      type: "website",
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#161826",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
