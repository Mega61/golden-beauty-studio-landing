import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState, ReadOnlyBand } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { can } from "@/lib/auth-policy";
import { requireSession } from "@/lib/dal";

import { loadRecuperar } from "./data";
import { RecuperarVista } from "./RecuperarVista";

/**
 * `/admin/clientes/recuperar` — "Te extrañamos".
 *
 * Las clientas que dejaron de venir, con un botón que les manda por WhatsApp
 * una tarjeta de sellos nueva que ya trae sellos de regalo y el 10 % en su
 * próxima cita. Abajo, las que ya lo recibieron y si volvieron. La dueña
 * configura la campaña, el mensaje y las condiciones en la misma pantalla.
 * Reglas en `lib/winback.ts`.
 */

export const metadata: Metadata = {
  title: "Recuperar clientas · Clientes · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function RecuperarPage() {
  const session = await requireSession();
  const role: UserRole = session.role;
  if (!can(role, "recuperar:enviar")) {
    return (
      <AppShell role={navRole(role)} title="Recuperar clientas">
        <EmptyState
          icon="candado"
          title="Recuperar clientas es de la dueña o de recepción"
          body="Desde aquí se le regala una tarjeta de sellos y un descuento a quien dejó de venir, por el WhatsApp del estudio."
        />
      </AppShell>
    );
  }

  const load = await loadRecuperar();

  return (
    <AppShell role={navRole(role)} title="Recuperar clientas">
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <a className="ui-btn ui-btn--ghost ui-btn--sm" href="/admin/clientes" style={{ justifySelf: "start" }}>
          ← Clientes
        </a>
        {!load.ok ? (
          <ReadOnlyBand reason={load.message} detailsHref="/diagnostico" />
        ) : (
          <RecuperarVista
            canConfigure={can(role, "recuperar:configurar")}
            today={load.today}
            settings={load.settings}
            pending={load.pending}
            sent={load.sent}
            campaigns={load.campaigns}
            stampeeProblem={load.stampeeProblem}
          />
        )}
      </div>
    </AppShell>
  );
}
