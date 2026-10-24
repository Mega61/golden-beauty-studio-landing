import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import Link from "next/link";

import { Icon, formatDateLong, formatTime } from "@/components/ui";
import { unmarkedAppointments } from "@/lib/attendance";
import { instantToEaLocal } from "@/lib/ea";
import { requireSession, sessionCan } from "@/lib/dal";
import type { UserRole } from "@/db/types";
import { loadComboCompositions } from "@/lib/combo-source";
import { cerrarCuenta, revisarPrimeraVisita } from "./actions";
import { loadToday } from "./data";
import { loadConfirmations, pendingConfirmations } from "../recordatorios/confirmations-data";
import { loadReminders } from "../recordatorios/data";
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

  const [verTodas, canCharge, canSeeTotals, canFixAfterClose, canRemind, canGiveCourtesy] =
    await Promise.all([
      sessionCan("agenda:ver-todas"),
      sessionCan("cuenta:cobrar"),
      sessionCan("caja:ver"),
      sessionCan("cuenta:corregir-tras-cierre"),
      sessionCan("recordatorios:enviar"),
      sessionCan("cortesia:otorgar"),
    ]);

  // El acceso a Recordatorios va acá con su conteo porque Hoy es la pantalla
  // que recepción abre primero: un "3 pendientes" a la vista es lo que hace
  // que la pasada diaria no dependa de acordarse. Si la carga falla, el acceso
  // sale sin número —nunca tumba Hoy por un dato accesorio.
  const [{ date, appointments, catalog, problems }, pendingReminders, comboSource] = await Promise.all([
    loadToday(session, { verTodas }),
    // Recordatorios **y** reservas nuevas por confirmar: los dos son mensajes
    // que salen del mismo botón de la misma pantalla.
    canRemind
      ? Promise.all([
          loadReminders().then((r) =>
            r.problems.length > 0 ? null : r.rows.filter((row) => row.state === "pendiente").length,
          ),
          loadConfirmations().then(pendingConfirmations),
        ])
          .then(([reminders, confirmations]) =>
            reminders === null || confirmations === null ? null : reminders + confirmations,
          )
          .catch(() => null)
      : Promise.resolve(null),
    // Para "¿también pies?" en la cuenta: el par que es un combo se cobra como
    // el combo. Nunca lanza; sin composiciones la hoja simplemente no lo ofrece.
    loadComboCompositions(),
  ]);

  const eaCaido = problems.find((p) => p.source === "ea") ?? null;
  const dbCaida = problems.find((p) => p.source === "db") ?? null;

  // Las citas que ya terminaron sin cuenta y sin marca. Es el recordatorio de
  // fin de jornada: la inasistencia solo se puede medir sobre lo que alguien
  // marcó, y lo que nadie marcó queda fuera de la tasa (`lib/attendance.ts`).
  // Sin EA no hay estados que leer, así que no se dice nada.
  const sinMarcar =
    eaCaido === null
      ? unmarkedAppointments(
          appointments.map((appointment) => ({
            ...appointment,
            closed: appointment.finance.closedAt !== null,
          })),
          instantToEaLocal(new Date()),
        )
      : [];

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

        {canRemind ? (
          // `Link` y no `ButtonLink`: un `<a>` crudo no lleva el `basePath`.
          <Link
            href="/recordatorios"
            className={`ui-btn ui-btn--${pendingReminders ? "primary" : "secondary"} ui-btn--block`}
          >
            <Icon name="mensaje" size={18} />
            {pendingReminders === null
              ? "Confirmaciones y recordatorios"
              : pendingReminders === 0
                ? "WhatsApp: nada pendiente"
                : pendingReminders === 1
                  ? "WhatsApp: 1 mensaje pendiente"
                  : `WhatsApp: ${pendingReminders} mensajes pendientes`}
          </Link>
        ) : null}

        {sinMarcar.length === 0 ? null : (
          <div
            role="status"
            style={{
              display: "flex",
              gap: "0.5rem",
              padding: "0.75rem",
              borderRadius: "var(--radius-md)",
              background: "var(--color-warn-tint)",
              border: "1px solid var(--color-warn-line)",
              color: "var(--color-warn-ink)",
            }}
          >
            <Icon name="reloj" size={18} style={{ flex: "none", marginTop: 1 }} />
            <span>
              <strong>
                {sinMarcar.length === 1
                  ? "1 cita de hoy sin marcar"
                  : `${sinMarcar.length} citas de hoy sin marcar`}
              </strong>
              {" — "}
              {sinMarcar
                .map((cita) => `${formatTime(cita.start)} ${cita.customerName}`)
                .join(" · ")}
              . Ya terminaron y no tienen cuenta: marca si llegó o no en su tarjeta.
            </span>
          </div>
        )}

        <TodayList
          appointments={appointments}
          catalog={catalog}
          scope={session.userId}
          canCharge={canCharge}
          canGiveCourtesy={canGiveCourtesy}
          canSeeTotals={canSeeTotals}
          canFixAfterClose={canFixAfterClose}
          readOnly={eaCaido !== null}
          action={cerrarCuenta}
          combos={comboSource.combos}
          checkFirstVisit={revisarPrimeraVisita}
        />
      </div>
    </AppShell>
  );
}
