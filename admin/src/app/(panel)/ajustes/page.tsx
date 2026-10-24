import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { Card, CardHead } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { can, receivesBookingPush } from "@/lib/auth-policy";
import { requireSession } from "@/lib/dal";
import { vapidConfig } from "@/lib/push/send";

import { activarAvisos, desactivarAvisos, probarAviso } from "./actions";
import { PushToggle } from "./PushToggle";

/**
 * **Ajustes** — lo que es de este dispositivo y no del estudio.
 *
 * Hoy son dos cosas: cómo instalar el panel en el celular, y los avisos de
 * reservas. La primera es de todas; la segunda se dibuja para quien le puede
 * llegar alguno —el de reservas web (dueña y recepción) o el de su propia
 * columna (la técnica, `avisos:mis-citas`)— **y** si el servidor tiene llaves
 * VAPID. Sin llaves la sección no aparece: un interruptor que no puede
 * funcionar es peor que no tenerlo.
 */

export const metadata: Metadata = {
  title: "Ajustes · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function AjustesPage() {
  const session = await requireSession();
  const vapid = vapidConfig();
  const showPush = vapid !== null && receivesBookingPush(session.role, session.eaProviderId);
  // La técnica recibe solo lo de su columna; la pantalla lo dice así.
  const onlyOwn = !can(session.role, "avisos:reservas-web");

  return (
    <AppShell role={navRole(session.role)} title="Ajustes">
      <div style={{ display: "grid", gap: "1rem", maxWidth: "40rem" }}>
        {showPush ? (
          <Card padded={false}>
            <CardHead title="Avisos de reservas" />
            <div style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
              <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>
                {onlyOwn
                  ? "Cuando te agendan una cita —por la página o desde el panel— te llega una notificación al momento, y al tocarla se abre la agenda en ese día."
                  : session.eaProviderId !== null
                    ? "Cuando alguien reserva desde la página te llega una notificación al momento, y también cuando te agendan una cita a ti desde el panel. Al tocarla se abre la agenda en ese día."
                    : "Cuando alguien reserva desde la página te llega una notificación al momento, y al tocarla se abre la agenda en ese día."}
              </p>
              <PushToggle
                onlyOwn={onlyOwn}
                vapidPublicKey={vapid.publicKey}
                activate={activarAvisos}
                deactivate={desactivarAvisos}
                test={probarAviso}
              />
            </div>
          </Card>
        ) : null}

        <Card padded={false}>
          <CardHead title="El panel en tu celular" />
          <div style={{ padding: "1rem", display: "grid", gap: "0.5rem" }}>
            <p style={{ margin: 0 }}>
              <strong>iPhone:</strong> abre el panel en Safari, toca <strong>Compartir</strong> (el
              cuadro con la flecha hacia arriba) y luego <strong>Agregar a inicio</strong>.
            </p>
            <p style={{ margin: 0 }}>
              <strong>Android:</strong> en Chrome, toca el menú <strong>⋮</strong> y luego{" "}
              <strong>Instalar app</strong> (o <strong>Agregar a la pantalla principal</strong>).
            </p>
            <p style={{ margin: 0, color: "var(--color-ink-soft)", fontSize: "var(--text-sm)" }}>
              Queda como una app, a pantalla completa. La agenda siempre se carga en vivo: el panel
              instalado no guarda copias viejas.
            </p>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
