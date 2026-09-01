import type { ReactNode } from "react";

/**
 * La escena del login.
 *
 * Es la única pantalla del panel sin `AppShell`: no hay barra lateral, ni riel,
 * ni barra inferior, porque todavía no hay nada a dónde navegar. Una sola
 * tarjeta centrada, y de ahí no se sale hasta entrar.
 *
 * Tres decisiones de forma, todas de § UX:
 *
 * - **`dvh` y no `vh`.** La recepcionista entra desde el celular; el chrome del
 *   navegador móvil colapsa al hacer scroll y con `vh` la tarjeta queda cortada
 *   por debajo del pliegue justo al abrir.
 * - **`env(safe-area-inset-*)`** en el padding: en un iPhone con notch, sin eso
 *   el botón primario queda debajo de la barra del sistema.
 * - **La tarjeta se centra, pero puede scrollear.** Con el teclado abierto en un
 *   celular de 390 px el viewport se parte a la mitad; `justify-center` a secas
 *   sobre un contenedor sin scroll esconde el campo que la persona está
 *   escribiendo.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflowY: "auto",
        background: "var(--color-ivory)",
        padding:
          "calc(env(safe-area-inset-top, 0px) + 1.5rem)" +
          " calc(env(safe-area-inset-right, 0px) + 1rem)" +
          " calc(env(safe-area-inset-bottom, 0px) + 1.5rem)" +
          " calc(env(safe-area-inset-left, 0px) + 1rem)",
      }}
    >
      <main style={{ width: "100%", maxWidth: "26rem" }}>{children}</main>
    </div>
  );
}
