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

import type { WaSentLabel } from "@/lib/whatsapp/sent-labels";

import type {
  Cop,
  FinanceItemKind,
  SnapshotSource,
  VarianceReasonCode,
} from "@/db/types";
import type { TicketPayment } from "@/lib/ticket";

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
  /** Con qué método —o métodos— se cobró. Vacío = todavía no se cobró. */
  payments: readonly TicketPayment[];
  /** Observaciones internas. **Nunca** se copian a las notas de la cita en EA. */
  serviceNotes: string;
  varianceReasonCode: VarianceReasonCode | null;
  varianceReason: string;
  /**
   * La cuenta se cerró como **cortesía de la casa** (migración `026`): no se
   * cobró, y la profesional cobra su comisión sobre el precio de lista.
   */
  houseCourtesy: boolean;
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
  /** La ficha de EA. `null` en modo degradado, cuando EA no respondió. */
  eaCustomerId: number | null;
  /**
   * La clienta está marcada como **cortesía de la casa por defecto** en su
   * ficha. Solo pre-marca la casilla de una cuenta nueva: no decide nada sola,
   * y la cuenta se puede cobrar igual —a veces pagan—.
   */
  houseCourtesyDefault: boolean;
  eaProviderId: number | null;
  providerName: string;
  bookedServiceId: number | null;
  bookedServiceName: string;
  /**
   * Lo que se agendó **además** del principal: el "+ pies" de un par que no es
   * combo (migración `028`). Una cuenta nueva los trae ya agregados como
   * servicios; una guardada manda lo que se guardó. Ausente = ninguno.
   */
  plannedServiceIds?: readonly number[];
  /**
   * Lo que ya se le mandó por WhatsApp ("Confirmación enviada"…). Solo se
   * muestra: no es el estado de la cita. Ausente = nada, o no se pudo leer.
   */
  waSent?: readonly WaSentLabel[];
  /**
   * La tarjeta de sellos de Stampee, solo cuando dice algo para hoy: premio
   * listo o a uno-dos sellos. Ausente = nada que avisar, o Stampee no respondió
   * a tiempo. Se cruza por celular en `hoy/page.tsx`.
   */
  loyalty?: { stage: "lista" | "cerca"; remaining: number; rewardName: string };
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
  /**
   * Cómo se cobró. Vacío = no se cobró.
   *
   * Con **un** pago el monto que viaje acá no se usa: el servidor le pone todo
   * lo cobrado, porque es él quien calcula el total definitivo. Con dos, los
   * montos son datos escritos y el servidor verifica que sumen.
   */
  payments: readonly TicketPayment[];
  tip: number;
  /**
   * Cerrar como **cortesía de la casa**: cobro cero, sin pagos ni propina, y la
   * comisión sobre el precio de lista. Solo la dueña (`cortesia:otorgar`).
   *
   * Opcional porque un borrador encolado antes de esta versión no lo trae, y
   * ausente es **no**: la cuenta se cobra.
   */
  houseCourtesy?: boolean;
  /**
   * Servicios hechos además del principal (ids de EA). Opcional por la misma
   * razón que la cortesía: un borrador encolado antes no lo trae, y ausente es
   * ninguno.
   */
  additionalServiceIds?: readonly number[];
  /**
   * Aplicar la promo que le toque. **Solo la elección**: cuánto descuenta lo
   * calcula el servidor con su catálogo y el día de la cita. Ausente es **no**:
   * un borrador de antes de las promos se cobró sin ellas.
   */
  applyPromo?: boolean;
  /**
   * La hoja la cerró como primera visita (10 %): por el historial o porque la
   * técnica lo marcó. El servidor no la reemplaza por lo que diga el historial
   * —eso cambiaría un cobro que ya se hizo—; la usa, y anota si coincidía.
   */
  firstVisit?: boolean;
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

/**
 * Lo que dijo el historial sobre si es su primera visita (`hoy/first-visit.ts`).
 * `desconocido` = no se pudo leer todo, y se trata como **no**: el 10 % no se
 * pone solo sobre una duda.
 *
 * Es lo único del historial que llega a la cuenta: un sí/no, nunca un monto.
 */
export type FirstVisitStatus = "primera" | "recurrente" | "desconocido";

/** La firma de la pregunta. La real es la Server Action `revisarPrimeraVisita`. */
export type FirstVisitCheck = (eaAppointmentId: number) => Promise<FirstVisitStatus>;
