import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * Layout raíz del panel.
 *
 * Dos tipografías y nada más:
 *
 * - **Inter** para todo. Etiquetas, botones, encabezados de tabla, cifras.
 * - **Cormorant** para exactamente dos cosas: el wordmark de la barra lateral y
 *   la pantalla de login. Se carga igual en la raíz porque el wordmark está en
 *   el shell de todas las pantallas; lo que no se hace nunca es usarla en un
 *   dato. Este es un registro de producto, no de marca.
 *
 * `next/font` las autoaloja en el build (nada sale a Google en tiempo de
 * ejecución) y las expone como variables CSS, que es lo que `--font-sans` y
 * `--font-display` de `globals.css` consumen.
 *
 * `lang="es-CO"` no es provisional: el panel es monolingüe a propósito. Los
 * diccionarios es/en son de la landing y no cruzan a `admin/`.
 */

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-cormorant",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Panel · Golden Beauty Studio",
  // El panel nunca se indexa: vive detrás de auth y de un rewrite.
  robots: { index: false, follow: false },
};

export function generateViewport(): Viewport {
  return {
    width: "device-width",
    initialScale: 1,
    // El panel es de tema claro y punto (§ La escena): no hay uso nocturno de
    // escritorio y el marfil de la marca ya es el fondo del estudio.
    colorScheme: "light",
    themeColor: "#f3ecdf",
    // La recepción trabaja de pie con una mano; el pellizco para acercar tiene
    // que seguir disponible. `maximumScale` queda fuera a propósito.
    viewportFit: "cover",
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-CO" className={`${inter.variable} ${cormorant.variable}`}>
      <body>
        {/* El proveedor de toasts envuelve todo y vive fuera de `<main>`: si la
            región `aria-live` se desmontara al navegar, el anuncio se perdería
            justo cuando importa. */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
