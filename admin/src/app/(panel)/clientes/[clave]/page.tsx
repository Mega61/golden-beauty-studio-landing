import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EmptyState, ReadOnlyBand } from "@/components/ui";
import { AppShell, TopbarBack } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";

import { FichaFidelidad } from "../../fidelidad/FichaFidelidad";
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
  title: "Cliente · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function ClientaPage({
  params,
}: {
  params: Promise<{ clave: string }>;
}) {
  const session = await requireCapability("agenda:ver-todas");

  const { clave } = await params;
  const key = parseClientKeyParam(clave);
  if (key === null) notFound();

  const [result, canGiveCourtesy, canSeeLoyalty, canRedeem] = await Promise.all([
    loadClientProfile(key),
    sessionCan("cortesia:otorgar"),
    sessionCan("fidelidad:ver"),
    sessionCan("fidelidad:canjear"),
  ]);

  if (!result.found) {
    // Un 404 acá mentiría: "no se pudo preguntar" y "no existe" son cosas
    // distintas, y confundirlas hace que alguien cree una clienta duplicada
    // porque el panel le dijo que no estaba.
    if (result.failure) {
      return (
        <AppShell role={navRole(session.role)} title="Clientes" back={<TopbarBack href="/clientes" label="Clientes" />}>
          <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
            <ReadOnlyBand
              reason={result.failure.message}
              detailsHref={result.failure.transient ? undefined : "/diagnostico"}
            />
            <EmptyState
              icon="alerta"
              title="No se pudo abrir la ficha"
              body="La agenda no respondió, así que no se sabe si esta ficha existe. No la crees de nuevo: vuelve a intentar en un momento."
            />
          </div>
        </AppShell>
      );
    }
    notFound();
  }

  return (
    <AppShell role={navRole(session.role)} title="Clientes" back={<TopbarBack href="/clientes" label="Clientes" />}>
      <FichaClienta
        profile={result.profile}
        canGiveCourtesy={canGiveCourtesy}
        fidelidad={
          canSeeLoyalty ? (
            // Stampee es otro servicio: la ficha no lo espera. La tarjeta de
            // sellos llega cuando llega.
            <Suspense fallback={null}>
              <FichaFidelidad phone={result.profile.client.phone} canRedeem={canRedeem} />
            </Suspense>
          ) : null
        }
      />
    </AppShell>
  );
}
