import type { Metadata } from "next";

import { requireCapability, sessionCan } from "@/lib/dal";

import { loadServicesView } from "./data";
import { ServiciosVista } from "./ServiciosVista";

/**
 * Servicios: catálogo en lectura y diff contra `src/data/pricing.ts`.
 *
 * Dos compuertas distintas y a propósito:
 *
 * - **Ver** el catálogo y el diff: `agenda:ver-todas` (dueña y recepción). La
 *   recepción tiene que poder mirar por qué un servicio no se puede agendar sin
 *   depender de que la dueña esté disponible. Es la misma aproximación que en
 *   Clientas: no existe todavía una capacidad `catalogo:ver`, y queda pedida.
 * - **Publicar**: `catalogo:publicar`, que es solo de la dueña. El botón se
 *   esconde cuando no alcanza, y la Server Action lo vuelve a verificar —
 *   esconder un botón es cortesía, no un permiso.
 */

export const metadata: Metadata = {
  title: "Servicios · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ServiciosPage() {
  await requireCapability("agenda:ver-todas");
  const puedePublicar = await sessionCan("catalogo:publicar");

  const view = await loadServicesView();

  return <ServiciosVista view={view} puedePublicar={puedePublicar} />;
}
