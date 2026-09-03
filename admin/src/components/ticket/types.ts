/**
 * El contrato entre la pantalla "Hoy" (servidor) y la hoja de la cuenta
 * (cliente).
 *
 * Vive en un archivo propio, sin React y sin `server-only`, porque lo importan
 * los dos lados: el Server Component que arma los datos y el componente cliente
 * que los pinta. Un tipo declarado en el componente cliente arrastraría el
 * `"use client"` al servidor; uno declarado en el módulo de datos arrastraría
 * Kysely al navegador.
 *
 * **Las horas son horas de pared** (`"2026-08-31 14:30:00"`), el tipo canónico
 * que fijó A1. Convertirlas a `Date` en el borde equivocado es de donde salen
 * los bugs de cinco horas, y acá el borde es la frontera servidor→cliente, que
 * es exactamente donde se serializa.
 */

import type {
  Cop,
  FinanceItemKind,
  PaymentMethod,
  SnapshotSource,
  VarianceReasonCode,
} from "@/db/types";

/**
 * Un renglón ya guardado.
 *
 * Viaja al cliente para poder **reabrir** una cuenta cerrada: hasta el cierre
 * diario la cuenta se puede corregir, y sin los renglones la hoja se abriría
 * vacía y la corrección sería en realidad un borrado. `lineTotal` no viene: se
 * recalcula desde `qty × unitPrice` con la misma función que todo lo demás.
 */
export type TicketItemView = {
  kind: FinanceItemKind;
  eaServiceId: number | null;
  qty: number;
  unitPrice: Cop;
  note: string | null;
};

/** Lo que `appointment_finance` sabe de esta cita. */
export type TicketFinanceView = {
  /** `null` = la cita todavía no tiene fila. Se crea al cerrar la cuenta. */
  financeId: number | null;
  performedServiceId: number | null;
  discount: Cop;
  tip: Cop;
  amountCharged: Cop | null;
  paymentMethod: PaymentMethod | null;
  /** Observaciones internas. **Nunca** se copian a las notas de la cita en EA. */
  serviceNotes: string;
  varianceReasonCode: VarianceReasonCode | null;
  varianceReason: string;
  /** Hora de pared del cierre de la cuenta. `null` = sigue abierta. */
  closedAt: string | null;
  /** La cuenta ya entró a un cierre diario: solo `owner`, y como ajuste. */
  frozenByDayClose: boolean;
  /** Precio de lista congelado al agendar. */
  snapshot: Cop | null;
  snapshotSource: SnapshotSource | null;
  /** Los renglones ya guardados, en orden de `id`. Vacío si la cuenta está abierta. */
  items: readonly TicketItemView[];
};

/** Una cita del día, con su cuenta al lado. */
export type TodayAppointment = {
  eaAppointmentId: number;
  /** Hora de pared. */
  start: string;
  end: string;
  /** El texto crudo de EA. La pastilla lo normaliza; el panel no lo traduce. */
  status: string;
  customerName: string;
  customerPhone: string | null;
  eaProviderId: number | null;
  providerName: string;
  bookedServiceId: number | null;
  bookedServiceName: string;
  finance: TicketFinanceView;
};

/**
 * Lo que la hoja manda al tocar "Guardar".
 *
 * Es el borrador tal cual, más el id del intento. **Ningún precio viaja acá**:
 * el servidor vuelve a valorar con su catálogo. Ver la cabecera de `draft.ts`.
 */
export type CloseTicketInput = {
  eaAppointmentId: number;
  performedServiceId: number | null;
  extras: Record<string, number>;
  manual: { note: string; amount: number } | null;
  totalOverride: number | null;
  varianceReasonCode: VarianceReasonCode | null;
  varianceReason: string;
  notes: string;
  paymentMethod: PaymentMethod | null;
  tip: number;
  /** Rastro del intento, para la bitácora. Ver `draft-store.ts`. */
  clientRequestId: string;
};

/**
 * El desenlace, **devuelto y no lanzado**.
 *
 * Una excepción en una Server Action llega al navegador como un digest opaco en
 * producción, y este flujo necesita distinguir tres cosas que un `catch` mezcla:
 * llegó y guardó, llegó y el servidor dijo que no, no llegó. Las dos primeras
 * son este tipo; la tercera es el rechazo del `fetch`, que la cola trata como
 * reintentable.
 *
 * `retryable` es lo que decide si la cuenta se queda en la cola. Un error de
 * validación con `retryable: true` dejaría el reintento golpeando el mismo
 * error cada treinta segundos hasta que alguien abra la consola.
 */
export type CloseTicketResult =
  | {
      ok: true;
      eaAppointmentId: number;
      financeId: number;
      amountCharged: Cop;
      tip: Cop;
      /** Hora de pared. */
      closedAt: string;
    }
  | { ok: false; retryable: boolean; message: string };

/** La firma que la hoja recibe como prop. La real es la Server Action. */
export type CloseTicketAction = (input: CloseTicketInput) => Promise<CloseTicketResult>;
