import type { MetadataRoute } from "next";

import { PANEL_BASE_PATH } from "@/lib/push/config";

/**
 * El manifest del panel: lo que hace que "Agregar a la pantalla de inicio" lo
 * instale como una app y no como un marcador.
 *
 * Next lo sirve en `/admin/manifest.webmanifest` y pone el `<link>` solo,
 * con el `basePath`. **Lo que va adentro, en cambio, no lo prefija nadie**:
 * `start_url`, `scope`, `id` y los íconos se escriben con `/admin` a mano. Sin
 * eso, el panel instalado abriría `/` — la landing — y el alcance de la app
 * sería todo el dominio, incluida la página pública.
 *
 * - `start_url` es `/admin/hoy` y no `/admin`: la raíz solo redirige, y un
 *   salto más al abrir la app es un parpadeo en cada arranque.
 * - `id` fija la identidad de la app instalada. Sin él, el navegador usa
 *   `start_url`, y cambiar la pantalla de arranque algún día la convertiría
 *   en "otra app" y duplicaría el ícono.
 * - Los colores son los tokens de `globals.css`: `--color-ivory` de fondo
 *   (la pantalla de arranque) y `--color-cream` de tema, el mismo `themeColor`
 *   del layout raíz, para que la barra del sistema no cambie de color al
 *   terminar de cargar.
 * - Los íconos salen del sello redondo de la marca, generados por
 *   `scripts/build-favicon.mjs` de la landing — el mismo origen que la pestaña.
 */
export default function manifest(): MetadataRoute.Manifest {
  const base = PANEL_BASE_PATH;
  return {
    id: `${base}/`,
    name: "Golden · Panel",
    short_name: "Golden",
    description: "Agenda, caja y equipo de Golden Beauty Studio.",
    lang: "es-CO",
    dir: "ltr",
    start_url: `${base}/hoy`,
    scope: `${base}/`,
    display: "standalone",
    background_color: "#f8f4ee",
    theme_color: "#f3ecdf",
    icons: [
      { src: `${base}/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${base}/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: `${base}/icons/icon-512-maskable.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
