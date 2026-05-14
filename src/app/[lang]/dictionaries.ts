import "server-only";

const dictionaries = {
  es: () => import("./dictionaries/es.json").then((m) => m.default),
  en: () => import("./dictionaries/en.json").then((m) => m.default),
} as const;

export type Locale = keyof typeof dictionaries;
export const locales: Locale[] = ["es", "en"];

export const hasLocale = (l: string): l is Locale => l in dictionaries;
export const getDictionary = async (l: Locale) => dictionaries[l]();

export type Dictionary = Awaited<ReturnType<typeof getDictionary>>;
