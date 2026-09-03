import type { NextConfig } from "next";
import path from "node:path";

/**
 * El panel se sirve en `goldenbeautystudio.com.co/admin`, pero corre en la VM.
 * La landing (en Vercel) hace un rewrite `beforeFiles` de `/admin/:path*` hacia
 * este origen; para que ese rewrite baste, la app tiene que generar TODAS sus
 * rutas y sus chunks ya prefijados con `/admin`. Eso es `basePath`.
 *
 * Sin `basePath`, el navegador le pediría `/_next/...` a Vercel, que no tiene
 * esos hashes: la página carga sin estilos y con 404 en consola. Es el error
 * más común de esta arquitectura, junto con el matcher de `src/proxy.ts` en la
 * landing.
 *
 * OJO: `next.config.ts` se lee en el BUILD y se serializa dentro de
 * `server.js`. `basePath`, headers y rewrites quedan horneados en la imagen:
 * cambiarlos exige reconstruir, no reiniciar el contenedor.
 */

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // El panel no se embebe en ningún lado. A diferencia de la landing
  // (SAMEORIGIN), acá no hay caso de uso legítimo para un iframe.
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  basePath: "/admin",

  /**
   * Los orígenes desde los que se aceptan Server Actions.
   *
   * **Sin esto, ningún botón del panel funciona en producción.** Next protege
   * las Server Actions contra CSRF comparando el header `Origin` con el `Host`,
   * y detrás del rewrite esos dos valores nunca coinciden: el navegador manda
   * `Origin: https://www.goldenbeautystudio.com.co` y el contenedor recibe
   * `Host: panel.goldenbeautystudio.com.co`. Next rechaza la acción, y lo que la
   * persona ve es *"A server error occurred"* sin una sola pista de por qué —
   * el endpoint de auth responde perfecto, la página carga, y solo el botón
   * falla.
   *
   * Es la contrapartida exacta del `basePath`: las dos existen porque el panel
   * se sirve en un dominio y se ejecuta en otro. La documentación de Next lo
   * llama por su nombre — "reverse proxies or multi-layered backend
   * architectures" (`docs/01-app/02-guides/data-security.md`).
   *
   * La lista es explícita a propósito, sin comodines: son los dos hosts
   * públicos reales más los de desarrollo. Un `*` acá desactivaría la
   * protección CSRF que esta opción viene a reconfigurar, no a apagar.
   */
  experimental: {
    serverActions: {
      allowedOrigins: [
        "www.goldenbeautystudio.com.co",
        "goldenbeautystudio.com.co",
        "panel.goldenbeautystudio.com.co",
        "localhost:3000",
        "localhost:3001",
      ],
    },
  },

  // Deja el build en `.next/standalone`, con solo los archivos que el runtime
  // necesita. La imagen de Docker lo copia junto con `public/` y
  // `.next/static`, que standalone NO copia solo (paquete A4).
  output: "standalone",

  poweredByHeader: false,

  turbopack: {
    root: path.resolve(__dirname),
  },

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
