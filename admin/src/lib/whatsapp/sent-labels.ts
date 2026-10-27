import type { WaMessageKind, WaMessageStatus } from "@/db/types";

/**
 * Qué se le mandó a la clienta por WhatsApp, en forma de etiqueta para la cita.
 *
 * **No es el estado de la cita.** Mandar la confirmación o el recordatorio no
 * cambia nada en EA, a propósito: que el mensaje salió no quiere decir que la
 * clienta confirmó, y cada cambio de estado en EA le manda a la clienta un
 * correo de "tu cita cambió". `Confirmada` lo pone una persona cuando la
 * clienta contesta. Estas etiquetas solo dicen lo que ya está en `wa_message`,
 * para no tener que ir a Recordatorios a averiguarlo.
 *
 * Los dos recordatorios (24 h y 2 h) son una sola etiqueta: para quien mira la
 * agenda la pregunta es "¿ya se le recordó?", no cuál de los dos.
 */

export type WaSentLabelKind = "confirmacion" | "recordatorio";

export type WaSentLabel = {
  kind: WaSentLabelKind;
  /** `leido` solo existe por la API de Meta; por `wa.me` nunca se sabe. */
  state: "enviado" | "leido" | "fallido";
  text: string;
};

export type WaSentRow = {
  eaAppointmentId: number;
  kind: WaMessageKind;
  status: WaMessageStatus;
};

const KIND_OF: Record<WaMessageKind, WaSentLabelKind> = {
  confirmacion: "confirmacion",
  recordatorio_24h: "recordatorio",
  recordatorio_2h: "recordatorio",
};

/** `pendiente` y `omitido` no son nada que mostrar: no salió ningún mensaje. */
function stateOf(status: WaMessageStatus): WaSentLabel["state"] | null {
  switch (status) {
    case "enviado":
    case "entregado":
      return "enviado";
    case "leido":
      return "leido";
    case "fallido":
      return "fallido";
    default:
      return null;
  }
}

/** Mejor noticia primero: un recordatorio leído tapa a uno que falló. */
const RANK: Record<WaSentLabel["state"], number> = { leido: 3, enviado: 2, fallido: 1 };

const TEXT: Record<WaSentLabelKind, Record<WaSentLabel["state"], string>> = {
  confirmacion: {
    enviado: "Confirmación enviada",
    leido: "Confirmación leída",
    fallido: "Confirmación falló",
  },
  recordatorio: {
    enviado: "Recordatorio enviado",
    leido: "Recordatorio leído",
    fallido: "Recordatorio falló",
  },
};

/** Las etiquetas de cada cita, confirmación antes que recordatorio. */
export function waSentLabelsByAppointment(
  rows: readonly WaSentRow[],
): Map<number, WaSentLabel[]> {
  const best = new Map<number, Map<WaSentLabelKind, WaSentLabel["state"]>>();

  for (const row of rows) {
    const state = stateOf(row.status);
    if (state === null) continue;
    const kind = KIND_OF[row.kind];
    let byKind = best.get(row.eaAppointmentId);
    if (byKind === undefined) {
      byKind = new Map();
      best.set(row.eaAppointmentId, byKind);
    }
    const current = byKind.get(kind);
    if (current === undefined || RANK[state] > RANK[current]) byKind.set(kind, state);
  }

  const out = new Map<number, WaSentLabel[]>();
  for (const [id, byKind] of best) {
    const labels: WaSentLabel[] = [];
    for (const kind of ["confirmacion", "recordatorio"] as const) {
      const state = byKind.get(kind);
      if (state !== undefined) labels.push({ kind, state, text: TEXT[kind][state] });
    }
    out.set(id, labels);
  }
  return out;
}
