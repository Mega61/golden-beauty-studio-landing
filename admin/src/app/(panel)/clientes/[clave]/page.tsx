import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState, ReadOnlyBand } from "@/components/ui";
import { requireCapability } from "@/lib/dal";

import { loadClientProfile } from "../data";
import { FichaClienta } from "../FichaClienta";
import { parseClientKeyParam } from "../identity";

/**
 * La ficha de una clienta.
 *
 * El segmento es la **llave de identidad**, no un id de fila: `573001234567`
 * para una persona (que puede tener varias fichas en EA) o `ea-482` para una
 * fila que no se pudo deduplicar porque no tiene teléfono. Ver `identity.ts`.
 */

export const metadata: Metadata = {
  title: "Clienta · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ClientaPage({
  params,
}: {
  params: Promise<{ clave: string }>;
}) {
  await requireCapability("agenda:ver-todas");

  const { clave } = await params;
  const key = parseClientKeyParam(clave);
  if (key === null) notFound();

  const result = await loadClientProfile(key);

  if (!result.found) {
    // Un 404 acá mentiría: "no se pudo preguntar" y "no existe" son cosas
    // distintas, y confundirlas hace que alguien cree una clienta duplicada
    // porque el panel le dijo que no estaba.
    if (result.failure) {
      return (
        <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          <ReadOnlyBand
            reason={result.failure.message}
            detailsHref={result.failure.transient ? undefined : "/diagnostico"}
          />
          <EmptyState
            icon="alerta"
            title="No se pudo abrir la ficha"
            body="La agenda no respondió, así que no se sabe si esta clienta existe. No la crees de nuevo: vuelve a intentar en un momento."
          />
        </div>
      );
    }
    notFound();
  }

  return <FichaClienta profile={result.profile} />;
}
