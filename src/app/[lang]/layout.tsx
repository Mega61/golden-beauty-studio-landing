import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter, Italianno } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import { notFound } from "next/navigation";
import "../globals.css";
import { siteConfig, ogLocales } from "@/config/site";
import { resolveDescription } from "@/lib/seo";
import { getDictionary, hasLocale, locales, type Locale } from "./dictionaries";
import Preconnect from "./_components/Preconnect";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const italianno = Italianno({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-italianno",
  display: "swap",
});

export async function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export function generateViewport(): Viewport {
  return {
    width: "device-width",
    initialScale: 1,
    colorScheme: "light",
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#f8f4ee" },
      { media: "(prefers-color-scheme: dark)", color: "#1c1714" },
    ],
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  const title = dict.meta.title;
  const description = resolveDescription(dict, lang);
  const ogLocale = ogLocales[lang] ?? "es_CO";
  const alternateLocale = lang === "es" ? "en_US" : "es_CO";

  return {
    metadataBase: new URL(siteConfig.siteUrl),
    title,
    description,
    keywords: dict.meta.keywords,
    applicationName: "Golden Beauty Studio",
    authors: [{ name: "Golden Beauty Studio" }],
    creator: "Golden Beauty Studio",
    publisher: "Golden Beauty Studio",
    category: "beauty",
    alternates: {
      canonical: `/${lang}`,
      languages: {
        es: "/es",
        en: "/en",
        "x-default": "/es",
      },
    },
    openGraph: {
      type: "website",
      siteName: "Golden Beauty Studio",
      title,
      description,
      url: `/${lang}`,
      locale: ogLocale,
      alternateLocale,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    appleWebApp: {
      capable: true,
      title: "Golden",
      statusBarStyle: "black-translucent",
    },
    manifest: "/manifest.webmanifest",
    ...(siteConfig.googleSiteVerification
      ? { verification: { google: siteConfig.googleSiteVerification } }
      : {}),
  };
}

export default async function LangLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const typedLang: Locale = lang;

  return (
    <html
      lang={typedLang}
      className={`${cormorant.variable} ${inter.variable} ${italianno.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-ivory text-ink">
        <Preconnect />
        {children}
      </body>
      {siteConfig.gaId ? <GoogleAnalytics gaId={siteConfig.gaId} /> : null}
    </html>
  );
}
