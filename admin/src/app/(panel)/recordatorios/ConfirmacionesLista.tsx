"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, ButtonLink, Icon, StatusPill, useToast } from "@/components/ui";

import type { ManualConfirmationResult } from "./confirmation-send";
import type { ConfirmationView } from "./confirmations-data";
import { openWhatsappAfter } from "./open-whatsapp";

/**
 * **Reservas nuevas**: lo que se agendó en la última semana —por la página o
 * desde la agenda— con su botón para confirmarle a la clienta por WhatsApp.
 *
 * La más nueva arriba: quien acaba de reservar es quien está esperando el
 * mensaje. Lo ya confirmado se queda en la lista (con quién y cuándo) para que
 * nadie le escriba dos veces; lo pendiente se cuenta en el encabezado y en Hoy.
 */
export function ConfirmacionesLista({
  rows,
  readOnly,
  send,
}: {
  rows: readonly ConfirmationView[];
  /** La base no responde: no se puede registrar, así que no se ofrece mandar. */
  readOnly: boolean;
  send: (input: { eaAppointmentId: number }) => Promise<ManualConfirmationResult>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const pendientes = rows.filter(
    (r) => r.state === "pendiente" || r.state === "fallo-automatico",
  ).length;

  async function onSend(row: ConfirmationView) {
    setBusy(row.eaAppointmentId);
    try {
      const { result, opened } = await openWhatsappAfter(() =>
        send({ eaAppointmentId: row.eaAppointmentId }),
      );
      if (!result.ok) {
        toast({ message: result.message, tone: "error", duration: 0 });
        return;
      }
      toast({
        message: result.already
          ? `Ya estaba confirmada. ${result.sentLabel}.`
          : opened
            ? "Confirmación registrada. Dale enviar en WhatsApp."
            : "Confirmación registrada. El navegador no abrió WhatsApp: usa «Abrir de nuevo».",
        tone: opened ? "ok" : "warn",
      });
      router.refresh();
    } catch {
      toast({ message: "No se pudo conectar con el panel. Intenta de nuevo.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ display: "grid", gap: "0.625rem" }} aria-labelledby="reservas-nuevas">
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
        <h2
          id="reservas-nuevas"
          style={{ margin: 0, fontSize: "var(--text-lg)", color: "var(--color-carbon)" }}
        >
          Reservas nuevas
        </h2>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          últimos 7 días ·{" "}
          {pendientes === 0
            ? "nada por confirmar"
            : pendientes === 1
              ? "1 por confirmar"
              : `${pendientes} por confirmar`}
        </span>
      </header>

      {rows.length === 0 ? (
        <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>
          No hay reservas nuevas. Cuando alguien reserve por la página o se agende una cita en el
          panel, aparece acá para confirmarle por WhatsApp.
        </p>
      ) : (
        rows.map((row) => (
          <ConfirmationCard
            key={row.eaAppointmentId}
            row={row}
            busy={busy === row.eaAppointmentId}
            disabled={readOnly || (busy !== null && busy !== row.eaAppointmentId)}
            onSend={() => void onSend(row)}
          />
        ))
      )}
    </section>
  );
}

/** Lo que dice cada estado que no es "pendiente" ni "confirmada". */
const STATE_NOTE: Record<
  Exclude<ConfirmationView["state"], "pendiente" | "confirmada">,
  string
> = {
  "fallo-automatico": "La confirmación automática no salió. Mándala a mano.",
  "sin-telefono": "Sin teléfono válido. Corrígelo en Clientes para poder escribirle.",
  "opt-out": "Pidió no recibir mensajes del estudio.",
  "estado-no-aplica": "Por su estado en la agenda, esta cita no lleva confirmación.",
  "no-enviada": "Hay un registro de esta confirmación que dice que no salió.",
};

function ConfirmationCard({
  row,
  busy,
  disabled,
  onSend,
}: {
  row: ConfirmationView;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
}) {
  const pending = row.state === "pendiente" || row.state === "fallo-automatico";

  return (
    <article className="ui-card" style={{ display: "grid", gap: "0.625rem", padding: "0.875rem" }}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: "0.625rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            className="ui-num"
            style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}
          >
            {row.whenLabel} · {row.serviceName}
          </p>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: "var(--color-carbon)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.customerName}
          </h3>
          <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            {row.bookedLabel}
          </p>
        </div>
        {row.status === "" ? null : <StatusPill status={row.status} size="sm" />}
      </header>

      {row.state === "confirmada" ? (
        <p
          style={{
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.3125rem",
            fontSize: "var(--text-2xs)",
            fontWeight: 600,
            color: "var(--color-st-completada-ink)",
          }}
        >
          <Icon name="check" size={14} /> {row.sentLabel}
          {row.delivery === null ? null : (
            <span style={{ fontWeight: 400, color: "var(--color-ink-soft)" }}>· {row.delivery}</span>
          )}
        </p>
      ) : row.state === "pendiente" ? null : (
        <p
          style={{
            margin: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.3125rem",
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
          }}
        >
          <Icon name="info" size={14} style={{ flex: "none" }} /> {STATE_NOTE[row.state]}
          {row.autoError === null ? null : ` (${row.autoError})`}
        </p>
      )}

      {pending ? (
        <Button
          variant="primary"
          block
          icon="mensaje"
          loading={busy}
          disabled={disabled || row.link === null}
          onClick={onSend}
        >
          {row.state === "fallo-automatico"
            ? "Confirmar a mano por WhatsApp"
            : "Enviar confirmación por WhatsApp"}
        </Button>
      ) : null}

      {row.state === "confirmada" && row.link !== null ? (
        <ButtonLink
          variant="secondary"
          block
          icon="externo"
          href={row.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          Abrir de nuevo
        </ButtonLink>
      ) : null}
    </article>
  );
}
