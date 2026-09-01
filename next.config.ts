import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

// Hosts allowed for next/image remote sources. Lookbook photos are served from
// Strapi → GCS (and/or a Cloudflare-fronted media subdomain). Add the delivery
// host via NEXT_PUBLIC_MEDIA_HOST (e.g. media.goldenbeautystudio.com.co); the
// raw GCS host and localhost dev are always permitted.
const mediaHosts = [
  process.env.NEXT_PUBLIC_MEDIA_HOST,
  "storage.googleapis.com",
].filter((h): h is string => Boolean(h));

const remotePatterns = [
  ...mediaHosts.map((hostname) => ({
    protocol: "https" as const,
    hostname,
    pathname: "/**",
  })),
  {
    protocol: "http" as const,
    hostname: "localhost",
    port: "1337",
    pathname: "/**",
  },
];

/**
 * Origen del panel de administración: la VM, detrás de Caddy.
 *
 * El panel es una app Next hermana (`admin/`) que **no corre en Vercel** — sus
 * reportes necesitan agregación SQL contra un MySQL privado que las funciones
 * de Vercel no alcanzan. Lo pedido se conserva igual: la URL sigue siendo
 * `goldenbeautystudio.com.co/admin`, y este rewrite es lo que la sostiene.
 *
 * En producción: `ADMIN_ORIGIN=https://panel.goldenbeautystudio.com.co`
 * (variable de entorno del proyecto de Vercel). En desarrollo,
 * `http://localhost:3001` — ver `docs/DEV-LOCAL.md` § Paso 6.
 *
 * Sin la variable no hay rewrite y `/admin` da 404, que es lo correcto: un
 * preview de Vercel sin `ADMIN_ORIGIN` no debería intentar proxear a ningún
 * lado.
 */
const adminOrigin = process.env.ADMIN_ORIGIN?.replace(/\/$/, "");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns,
    // Dev only: the local Strapi serves media from http://localhost:1337, which
    // resolves to a private IP (127.0.0.1/::1). Next's image optimizer blocks
    // private-IP upstreams by default as SSRF protection. In production media is
    // served from the public GCS/Cloudflare host, so this stays OFF there.
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    // Incluye `/admin/*`, que se rewritea a la VM. El panel manda además su
    // propio `X-Frame-Options: DENY` (más estricto que el SAMEORIGIN de acá) y
    // la duplicación no cambia el resultado: ninguna de las dos permite que lo
    // embeban. No se excluye con un lookahead para no arriesgar que un patrón
    // mal escrito deje a la landing entera sin cabeceras.
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  /**
   * `beforeFiles` y no `afterFiles`: tiene que ganarle al sistema de archivos
   * y a las rutas dinámicas de la landing. Con `[lang]` en la raíz, `/admin`
   * podría interpretarse como un idioma.
   *
   * ⚠ Este rewrite es el paso 4 del enrutamiento; `src/proxy.ts` es el 3. Si
   * `admin` no está excluido del matcher de ahí, `/admin` se redirige a
   * `/es/admin` **antes** de que esto dispare y el panel nunca se sirve. Es el
   * error silencioso más fácil de cometer en esta arquitectura.
   *
   * Las dos entradas: `/admin` a secas y `/admin/:path*`. La segunda cubre
   * también los chunks — el panel corre con `basePath: "/admin"` justo para
   * que sus assets queden bajo `/admin/_next/*` y un solo rewrite alcance para
   * páginas y estáticos.
   */
  async rewrites() {
    if (!adminOrigin) return { beforeFiles: [], afterFiles: [], fallback: [] };

    return {
      beforeFiles: [
        { source: "/admin", destination: `${adminOrigin}/admin` },
        { source: "/admin/:path*", destination: `${adminOrigin}/admin/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
