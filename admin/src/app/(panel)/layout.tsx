import type { ReactNode } from "react";

import { PanelFrame, type Role } from "@/components/shell";
import type { UserRole } from "@/db/types";
import { requireSession } from "@/lib/dal";

/**
 * El grupo autenticado del panel.
 *
 * Todo lo que cuelga de `(panel)` — Hoy, Agenda, Caja, Clientas, Servicios,
 * Equipo, Comisiones, Reportes, Diagnóstico — pasa por acá, y por acá se pasa
 * por `requireSession()`, que redirige al login si no hay sesión.
 *
 * ## Esto no reemplaza al DAL en cada pantalla
 *
 * Un layout **no** es una compuerta de seguridad suficiente. En el App Router,
 * un layout se evalúa una vez y no vuelve a correr en cada navegación del
 * cliente; además, una Server Action o un Route Handler no lo atraviesan
 * jamás. Que este archivo llame a `requireSession()` es conveniencia y buena
 * experiencia —una redirección temprana en vez de una pantalla vacía—, no
 * autorización.
 *
 * **Cada Server Component que lee datos, y cada Server Action que escribe,
 * vuelve a llamar al DAL.** Está memoizado con `cache()` de React, así que
 * repetirlo dentro del mismo render es gratis; omitirlo es lo que cuesta caro.
 * Y las capacidades por rol (`requireCapability`, `requireOwnProvider`) se
 * comprueban donde se usan, no acá: este layout no sabe qué va a hacer la
 * pantalla que envuelve.
 *
 * ## El marco vive acá; la toolbar, en cada pantalla
 *
 * `PanelFrame` —barra lateral, riel, barra inferior— se dibuja una vez en este
 * layout con el rol de la sesión, y por eso no se vuelve a montar al navegar:
 * tocar un destino responde en el acto y la barra no parpadea. Cada pantalla
 * sigue aportando su `title` y sus `actions` con `<AppShell>` propio, que es
 * solo la columna de contenido.
 *
 * Consecuencia para las `vista-previa`: el `?rol=` cambia lo que la pantalla
 * muestra, pero la navegación es siempre la de la sesión real.
 */
/** `admin` en la base es recepción en la navegación. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function PanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireSession();

  return <PanelFrame role={navRole(session.role)}>{children}</PanelFrame>;
}
