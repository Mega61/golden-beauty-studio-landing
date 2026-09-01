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
