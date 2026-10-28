import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState, Icon } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";
import { loadLoyalty } from "@/lib/stampee/client";
import { activeRows } from "@/lib/stampee/model";

import { normalizePhoneE164 } from "../clientes/identity";
import { FidelidadVista, type FidelidadRow } from "./FidelidadVista";

/**
 * **Fidelidad** — las tarjetas de sellos de Stampee, vistas desde el panel.
 *
 * Contesta tres preguntas, en este orden: ¿a quién hay que aplicarle el premio?
 * ¿quién está a uno o dos sellos? ¿cómo va cada campaña? Los sellos los pone el
 * CRM cada noche desde las visitas; esta pantalla los lee y lo único que
 * escribe es "premio aplicado". Ver `lib/stampee/client.ts`.
 */

export const metadata: Metadata = {
  title: "Fidelidad · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function FidelidadPage() {
  const session = await requireCapability("fidelidad:ver");
  const [result, canRedeem] = await Promise.all([loadLoyalty(), sessionCan("fidelidad:canjear")]);

  if (!result.ok) {
    return (
      <AppShell role={navRole(session.role)} title="Fidelidad">
        <EmptyState
          icon={result.reason === "sin-configurar" ? "ajustes" : "alerta"}
          title={result.reason === "sin-configurar" ? "Stampee no está conectado" : "Stampee no respondió"}
          body={result.message}
        />
      </AppShell>
    );
  }

  const { data, stale } = result;
  const rows: FidelidadRow[] = activeRows(data).map(({ client, card }) => {
    const e164 = normalizePhoneE164(client.mobile);
    return {
      key: card.id,
      clientName: client.name,
      mobile: client.mobile,
      fichaHref: e164 ? `/clientes/${e164.slice(1)}` : null,
      cardUrl: data.cardBaseUrl ? `${data.cardBaseUrl}/${card.uniqueId}` : null,
      card,
    };
  });
  const redeemed = data.campaigns.reduce((sum, c) => sum + c.canjeadas, 0);

  return (
    <AppShell role={navRole(session.role)} title="Fidelidad">
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        {stale ? (
          <div role="status" className="ui-callout ui-callout--warn">
            <Icon name="reloj" size={18} />
            <span>
              Stampee no respondió: esto es lo último que se leyó, a las{" "}
              {data.fetchedAt.toLocaleTimeString("es-CO", {
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Bogota",
              })}
              .
            </span>
          </div>
        ) : null}
        <FidelidadVista
          rows={rows}
          campaigns={data.campaigns}
          redeemedTotal={redeemed}
          canRedeem={canRedeem}
        />
      </div>
    </AppShell>
  );
}
