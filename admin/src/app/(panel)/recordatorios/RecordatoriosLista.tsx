"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, ButtonLink, EmptyState, Icon, StatusPill, useToast } from "@/components/ui";

import type { OptoutResult, SendReminderResult } from "./actions";
import type { ReminderView } from "./data";

/**
 * La lista de recordatorios, en dos bloques: lo que falta hoy y mañana.
 *
 * ## Cómo se abre WhatsApp sin que el navegador lo bloquee
 *
 * El enlace sale del servidor **después** de registrar el aviso (ver
 * `actions.ts`), y un `window.open` hecho después de un `await` ya no cuenta
 * como gesto de la usuaria: Safari en iPhone lo bloquea en silencio. Así que
 * la pestaña se abre vacía en el mismo toque y se le pone la dirección cuando
 * llega. Si el navegador la bloqueó igual, la fila queda en "Recordada" con
 * su botón "Abrir de nuevo", que es un enlace normal.
 */
export function RecordatoriosLista({
  rows,
  todayLabel,
  tomorrowLabel,
  readOnly,
  canOptOut,
  send,
  optOut,
}: {
  rows: readonly ReminderView[];
  todayLabel: string;
  tomorrowLabel: string;
  /** La base no responde: no se puede registrar, así que no se ofrece mandar. */
  readOnly: boolean;
  canOptOut: boolean;
  send: (input: { eaAppointmentId: number }) => Promise<SendReminderResult>;
  optOut: (input: { eaAppointmentId: number }) => Promise<OptoutResult>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const hoy = rows.filter((r) => r.day === "hoy");
  const manana = rows.filter((r) => r.day === "manana");

  async function onSend(row: ReminderView) {
    // En el mismo toque, antes de cualquier `await`. Se corta el `opener`
    // para que la pestaña de WhatsApp no tenga una referencia al panel.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;

    setBusy(row.eaAppointmentId);
    try {
      const result = await send({ eaAppointmentId: row.eaAppointmentId });
      if (!result.ok) {
        tab?.close();
        toast({ message: result.message, tone: "error", duration: 0 });
        return;
      }
      if (tab) tab.location.href = result.url;
      toast({
        message: result.already
          ? `Ya estaba recordada. ${result.sentLabel}.`
          : tab
            ? "Aviso registrado. Dale enviar en WhatsApp."
            : "Aviso registrado. El navegador no abrió WhatsApp: usa «Abrir de nuevo».",
        tone: tab ? "ok" : "warn",
      });
      router.refresh();
    } catch {
      tab?.close();
      toast({ message: "No se pudo conectar con el panel. Intenta de nuevo.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onOptOut(row: ReminderView) {
    setBusy(row.eaAppointmentId);
    try {
      const result = await optOut({ eaAppointmentId: row.eaAppointmentId });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    } catch {
      toast({ message: "No se pudo conectar con el panel. Intenta de nuevo.", tone: "error" });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="mensaje"
        title="No hay recordatorios por mandar"
        body="Cuando haya citas para lo que queda de hoy o para mañana, van a aparecer acá con su botón de WhatsApp."
      />
    );
  }

  const section = (title: string, subtitle: string, list: readonly ReminderView[]) => {
    const pendientes = list.filter((r) => r.state === "pendiente").length;
    return (
      <section style={{ display: "grid", gap: "0.625rem" }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-lg)", color: "var(--color-carbon)" }}>
            {title}
          </h2>
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            {subtitle} ·{" "}
            {pendientes === 0
              ? "nada pendiente"
              : pendientes === 1
                ? "1 pendiente"
                : `${pendientes} pendientes`}
          </span>
        </header>
        {list.length === 0 ? (
          <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>Sin citas.</p>
        ) : (
          list.map((row) => (
            <ReminderCard
              key={`${row.eaAppointmentId}:${row.kind}`}
              row={row}
              busy={busy === row.eaAppointmentId}
              disabled={busy !== null && busy !== row.eaAppointmentId}
              readOnly={readOnly}
              canOptOut={canOptOut}
              confirming={confirming === row.eaAppointmentId}
              onSend={() => void onSend(row)}
              onAskOptOut={() => setConfirming(row.eaAppointmentId)}
              onCancelOptOut={() => setConfirming(null)}
              onOptOut={() => void onOptOut(row)}
            />
          ))
        )}
      </section>
    );
  };

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {section("Hoy", `lo que falta del ${todayLabel}`, hoy)}
      {section("Mañana", tomorrowLabel, manana)}
    </div>
  );
}

/** Lo que dice cada estado que no es "pendiente". */
const STATE_NOTE: Record<Exclude<ReminderView["state"], "pendiente" | "recordada">, string> = {
  "sin-telefono": "Sin teléfono válido. Corrígelo en Clientas para poder avisarle.",
  "opt-out": "Pidió no recibir recordatorios.",
  "estado-no-aplica": "Por su estado en la agenda, esta cita no lleva recordatorio.",
  "no-enviada": "Hay un registro de este aviso que dice que no salió.",
};

function ReminderCard({
  row,
  busy,
  disabled,
  readOnly,
  canOptOut,
  confirming,
  onSend,
  onAskOptOut,
  onCancelOptOut,
  onOptOut,
}: {
  row: ReminderView;
  busy: boolean;
  disabled: boolean;
  readOnly: boolean;
  canOptOut: boolean;
  confirming: boolean;
  onSend: () => void;
  onAskOptOut: () => void;
  onCancelOptOut: () => void;
  onOptOut: () => void;
}) {
  const done = row.state === "recordada";
  const pending = row.state === "pendiente";

  return (
    <article className="ui-card" style={{ display: "grid", gap: "0.625rem", padding: "0.875rem" }}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: "0.625rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            className="ui-num"
            style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}
          >
            {row.timeLabel} · {row.serviceName}
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
        </div>
        {row.status === "" ? null : <StatusPill status={row.status} size="sm" />}
      </header>

      {row.state === "recordada" ? (
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
        </p>
      )}

      {pending ? (
        <Button
          variant="primary"
          block
          icon="mensaje"
          loading={busy}
          disabled={readOnly || disabled || row.link === null}
          onClick={onSend}
        >
          Enviar por WhatsApp
        </Button>
      ) : null}

      {done && row.link !== null ? (
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

      {pending && canOptOut && !readOnly ? (
        confirming ? (
          <div
            role="group"
            aria-label="Confirmar la baja"
            style={{ display: "grid", gap: "0.5rem", fontSize: "var(--text-xs)" }}
          >
            <span>
              ¿{row.customerName} pidió no recibir más recordatorios? Aplica a todas sus citas
              futuras.
            </span>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Button variant="danger" loading={busy} disabled={disabled} onClick={onOptOut}>
                Sí, no enviarle más
              </Button>
              <Button variant="ghost" disabled={busy} onClick={onCancelOptOut}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={onAskOptOut}>
            No quiere recordatorios
          </Button>
        )
      ) : null}
    </article>
  );
}
