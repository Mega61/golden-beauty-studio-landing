import type { Metadata } from "next";

import { requireCapability, sessionCan } from "@/lib/dal";

import { loadEquipoView } from "./data";
import { EquipoVista } from "./EquipoVista";

/**
 * Equipo: profesionales, espejo de Google y cuentas del panel.
 *
 * **Ver** con `agenda:ver-todas` (dueña y recepción): la recepción tiene que
 * poder mirar por qué una técnica no muestra disponibilidad sin depender de que
 * la dueña esté. **Administrar** con `equipo:administrar`, que es solo de la
 * dueña — dar de alta a alguien, enrolarle el código o cerrarle las sesiones no
 * es operación del día.
 *
 * Como en Clientas y Servicios, la capacidad de lectura es una aproximación:
 * no existe `equipo:ver` en `auth-policy.ts` y no es de este paquete agregarla.
 */

export const metadata: Metadata = {
  title: "Equipo · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function EquipoPage() {
  await requireCapability("agenda:ver-todas");
  const puedeAdministrar = await sessionCan("equipo:administrar");

  const view = await loadEquipoView();

  return <EquipoVista view={view} puedeAdministrar={puedeAdministrar} />;
}
