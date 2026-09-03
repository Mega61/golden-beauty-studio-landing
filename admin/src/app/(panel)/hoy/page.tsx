import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { Icon, formatDateLong } from "@/components/ui";
import { requireSession, sessionCan } from "@/lib/dal";
import type { UserRole } from "@/db/types";
import { cerrarCuenta } from "./actions";
import { loadToday } from "./data";
import { TodayList } from "./TodayList";

/**
 * **Hoy** — la raíz del panel para todos los roles.
 *
 * Para una técnica es su día: sus citas, y sobre cada una la acción primaria
 * "Cerrar servicio". Para recepción y para la dueña es el día completo, con los
 * montos a la vista.
 *
 * ## Lo que este archivo decide y lo que no
 *
 * Decide **qué se dibuja**: el rol define si se ven las demás citas y si se ven
 * los montos. No decide **qué se puede hacer**: eso lo vuelve a resolver la
 * Server Action con `requireCapability()` y `requireOwnProvider()`. Preguntar
 * dos veces es el diseño y no una redundancia — un botón escondido no es un
 * permiso, porque la Action que había detrás se puede invocar sin él.
 *
 * ## La ruta
 *
 * Vive en `/hoy` y no en `/`, que es lo que dice `components/shell/nav.ts`. La
 * raíz del panel sigue siendo el placeholder de WP-0 y ninguno de los dos
 * archivos pertenece a este paquete. Está reportado: hace falta que `/` redirija
 * acá, o que el destino "Hoy" apunte a `/hoy`.
 */

export const metadata: Metadata = {
  title: "Hoy · Panel",
};

/** El shell nombra a la recepción `reception`; la base la llama `admin`. */
function shellRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function HoyPage() {
  const session = await requireSession();

  const [verTodas, canCharge, canSeeTotals, canFixAfterClose] = await Promise.all([
    sessionCan("agenda:ver-todas"),
    sessionCan("cuenta:cobrar"),
    sessionCan("caja:ver"),
    sessionCan("cuenta:corregir-tras-cierre"),
  ]);

  const { date, appointments, catalog, problems } = await loadToday(session, { verTodas });

  const eaCaido = problems.find((p) => p.source === "ea") ?? null;
  const dbCaida = problems.find((p) => p.source === "db") ?? null;

  return (
    <AppShell
      role={shellRole(session.role)}
      title="Hoy"
      readOnly={
        eaCaido === null
          ? undefined
          : {
              reason:
                "La agenda no responde. Se ven las cuentas que ya están en el panel, pero no se puede guardar.",
            }
      }
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <p
          style={{
            margin: 0,
            fontSize: "var(--text-2xs)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--color-ink-soft)",
          }}
        >
          {formatDateLong(`${date} 00:00:00`)}
          {verTodas ? "" : " · tus citas"}
        </p>

        {dbCaida === null ? null : (
          <div
            role="alert"
            style={{
              display: "flex",
              gap: "0.5rem",
              padding: "0.75rem",
              borderRadius: "var(--radius-md)",
              background: "var(--color-error-tint)",
              border: "1px solid var(--color-error-line)",
              color: "var(--color-error-ink)",
            }}
          >
            <Icon name="alerta" size={18} style={{ flex: "none", marginTop: 1 }} />
            <span>
              No se pudo leer la base del panel, así que no hay cuentas ni precios. Las cuentas que
              se escriban ahora quedan pendientes en el celular hasta que vuelva.
            </span>
          </div>
        )}

        <TodayList
          appointments={appointments}
          catalog={catalog}
          scope={session.userId}
          canCharge={canCharge}
          canSeeTotals={canSeeTotals}
          canFixAfterClose={canFixAfterClose}
          readOnly={eaCaido !== null}
          action={cerrarCuenta}
        />
      </div>
    </AppShell>
  );
}
