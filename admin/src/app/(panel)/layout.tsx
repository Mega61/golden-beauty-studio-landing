import type { ReactNode } from "react";

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
 * ## Por qué el shell vive acá y no en cada pantalla
 *
 * `AppShell` necesita el rol para decidir la navegación —una técnica ve tres
 * destinos, la dueña todos— y el rol sale de la sesión. Ponerlo en cada
 * pantalla significaría cuatro paquetes resolviendo la sesión para lo mismo, y
 * cuatro versiones ligeramente distintas del mismo marco. Cada pantalla aporta
 * su `title` y sus `actions` con `<AppShell>` propio; lo que este layout
 * garantiza es que exista una sesión antes de que nada de eso se renderice.
 */
export default async function PanelLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireSession();

  return <>{children}</>;
}
