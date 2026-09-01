import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { match as matchLocale } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";

const locales = ["es", "en"] as const;
const defaultLocale = "es";

function getLocale(request: NextRequest): string {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const languages = new Negotiator({ headers }).languages();
  try {
    return matchLocale(languages, locales as unknown as string[], defaultLocale);
  } catch {
    return defaultLocale;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pathnameHasLocale = locales.some(
    (locale) =>
      pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );

  if (pathnameHasLocale) return;

  const locale = getLocale(request);
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

/**
 * `admin` está en el lookahead negativo por una razón que no se ve hasta que
 * rompe: Next 16 corre `proxy` (paso 3) **antes** de los rewrites `beforeFiles`
 * (paso 4). Sin excluirlo, este archivo redirige `/admin` → `/es/admin` y el
 * rewrite de `next.config.ts` hacia la VM nunca llega a dispararse — el panel
 * responde 404 y nada en los logs dice por qué.
 *
 * El panel no tiene idiomas: lo usan tres personas, en español, y su ruta la
 * sirve otra máquina.
 */
export const config = {
  matcher: [
    "/((?!_next|api|admin|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|textures|lookbook|.*\\.(?:jpg|jpeg|png|svg|webp|gif|ico)).*)",
  ],
};
