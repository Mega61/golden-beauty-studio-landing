import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { Icon, formatDateLong } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";

import { enviarConfirmacion, enviarRecordatorio, registrarBaja } from "./actions";
import { ConfirmacionesLista } from "./ConfirmacionesLista";
import { loadConfirmations } from "./confirmations-data";
import { loadReminders } from "./data";
import { RecordatoriosLista } from "./RecordatoriosLista";

/**
 * **Recordatorios** — los avisos por WhatsApp que hoy manda una persona.
 *
 * Es el paliativo de X7 mientras Meta no apruebe las plantillas de la Cloud
 * API: una lista de las citas que faltan hoy y las de mañana, y en cada una un
 * botón que registra el aviso y abre `wa.me` con el texto listo. Trabajo
 * humano diario, pero nadie se queda sin aviso el día que se cancele Agenda
 * Pro.
 *
 * Pantalla propia y no una sección de Hoy: Hoy es de la técnica también, y es
 * la pantalla de cerrar cuentas. Esto es trabajo de mostrador con otro ritmo
 * —una pasada en la mañana para mañana, otra al mediodía para lo que queda de
 * hoy— y en Hoy hay un acceso con el conteo de pendientes.
 *
 * Arriba van las **reservas nuevas** (`ConfirmacionesLista`): lo que se agendó
 * en la última semana, por la página o desde la agenda, con su botón para
 * confirmarle a la clienta. Mismo mecanismo que el recordatorio —la fila en
 * `wa_message` antes del enlace— con `kind = confirmacion`.
 */

export const metadata: Metadata = {
  title: "Recordatorios · Panel",
  robots: { index: false, follow: false },
};

/** Depende de la hora: lo que "falta hoy" cambia cada minuto. */
export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function RecordatoriosPage() {
  const session = await requireCapability("recordatorios:enviar");
  const [data, confirmations, canOptOut] = await Promise.all([
    loadReminders(),
    loadConfirmations(),
    sessionCan("recordatorios:baja"),
  ]);

  const problems = [...data.problems, ...confirmations.problems];
  const eaCaido = problems.find((p) => p.source === "ea") ?? null;
  const dbCaida = problems.find((p) => p.source === "db") ?? null;

  return (
    <AppShell role={navRole(session.role)} title="Recordatorios">
      <div style={{ display: "grid", gap: "1rem" }}>
        <p style={{ margin: 0, color: "var(--color-ink-soft)", maxWidth: "40rem" }}>
          {data.automatic
            ? "Las confirmaciones salen solas al reservar, y los recordatorios 24 horas y 2 horas antes de cada cita. Acá ves si llegaron. El botón sirve para los que el envío automático no pudo mandar; si lo usas antes, el automático ya no lo repite."
            : "Confirma cada reserva nueva y recuerda las citas de hoy y mañana. Cada botón abre WhatsApp con el mensaje listo: revisa que salga desde el WhatsApp del estudio y dale enviar allá."}
        </p>

        {eaCaido === null && dbCaida === null ? null : (
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
              {eaCaido !== null
                ? "La agenda no responde, así que no se pueden listar las citas. Intenta en un momento."
                : "No se pudo leer la base del panel. No se puede registrar ningún aviso, así que los botones quedan apagados hasta que vuelva."}
            </span>
          </div>
        )}

        {eaCaido !== null ? null : (
          <ConfirmacionesLista
            rows={confirmations.rows}
            readOnly={dbCaida !== null}
            send={enviarConfirmacion}
          />
        )}

        {eaCaido !== null ? null : (
          <RecordatoriosLista
            rows={data.rows}
            todayLabel={formatDateLong(`${data.today} 00:00:00`)}
            tomorrowLabel={formatDateLong(`${data.tomorrow} 00:00:00`)}
            readOnly={dbCaida !== null}
            canOptOut={canOptOut}
            send={enviarRecordatorio}
            optOut={registrarBaja}
          />
        )}
      </div>
    </AppShell>
  );
}
