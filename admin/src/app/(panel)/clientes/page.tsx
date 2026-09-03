import type { Metadata } from "next";

import { requireCapability } from "@/lib/dal";

import { ClientesLista } from "./ClientesLista";
import { searchClients } from "./data";

/**
 * Clientas: búsqueda y lista.
 *
 * ⚠ **La compuerta es `agenda:ver-todas` y eso es una aproximación.** No existe
 * todavía una capacidad `clientas:ver` en `auth-policy.ts` (paquete B2), y no
 * es de este paquete agregarla. `agenda:ver-todas` da exactamente el conjunto
 * correcto —dueña y recepción, nunca una técnica— y significa lo mismo en el
 * fondo: "esta sesión ve más allá de su propia silla". Queda pedida en el
 * reporte; el día que exista, es cambiar esta línea.
 */

export const metadata: Metadata = {
  title: "Clientas · Panel",
  robots: { index: false, follow: false },
};

/** Lee la sesión y consulta EA en cada visita: nada de esto se puede cachear. */
export const dynamic = "force-dynamic";

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("agenda:ver-todas");

  const params = await searchParams;
  const raw = params.q;
  const query = typeof raw === "string" ? raw : null;

  const result = await searchClients(query);

  return <ClientesLista result={result} />;
}
