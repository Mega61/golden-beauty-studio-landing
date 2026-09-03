import { parseEaLocalDate, parseEaLocalDateTime, type EaLocalDateTime } from "@/lib/ea";
import { reviewDay, type DayAccount, type DayAppointment } from "@/jobs/day-close";

import type { CajaView } from "../data";

/**
 * Días de mentira para revisar la pantalla de Caja sin EA ni cuentas reales.
 *
 * Los tres casos que hay que poder mirar de a 390, 768 y 1440 px son estados
 * distintos de la misma pantalla, y el del medio es el que importa: **la lista
 * de pendientes con el cierre bloqueado**. Un día limpio se ve bien por
 * accidente.
 *
 * La revisión **pasa por `reviewDay()`**, no por un `DayReview` escrito a mano.
 * Un fixture que fabricara los `issues` directamente podría mostrar una
 * combinación que la compuerta real nunca produce, y entonces lo que se estaría
 * revisando es un dibujo, no la pantalla.
 */

export const CASOS = ["pendientes", "limpio", "cerrado", "sin-agenda"] as const;
export type Caso = (typeof CASOS)[number];

export function parseCaso(raw: string | undefined): Caso {
  return CASOS.includes(raw as Caso) ? (raw as Caso) : "pendientes";
}

const DIA = parseEaLocalDate("2026-09-03");

/** Las 7:40 p. m. del día del estudio: la hora en que se cierra la caja. */
const AHORA = new Date("2026-09-04T00:40:00Z");

function wall(time: string): EaLocalDateTime {
  return parseEaLocalDateTime(`2026-09-03 ${time}`);
}

function cita(
  eaAppointmentId: number,
  desde: string,
  hasta: string,
  customerName: string,
  providerName: string,
  status = "Completada",
): DayAppointment {
  return {
    eaAppointmentId,
    status,
    start: wall(desde),
    end: wall(hasta),
    customerName,
    providerName,
  };
}

function cuenta(
  financeId: number,
  eaAppointmentId: number,
  amountCharged: number | null,
  paymentMethod: DayAccount["paymentMethod"],
  tip = 0,
  pushed = false,
): DayAccount {
  return {
    financeId,
    eaAppointmentId,
    amountCharged,
    tip,
    paymentMethod,
    paidOn: paymentMethod === null ? null : DIA,
    eaProviderId: 3,
    performedServiceId: 5,
    closedAt: new Date("2026-09-03T20:10:00Z"),
    dayCloseId: null,
    pushedToIngestAt: pushed ? new Date("2026-09-04T01:00:00Z") : null,
  };
}

const CITAS: DayAppointment[] = [
  cita(101, "08:30:00", "10:00:00", "Marcela Ríos", "Lina"),
  cita(102, "10:00:00", "11:30:00", "Daniela Castaño", "Lina"),
  cita(103, "10:30:00", "12:30:00", "Sara Villegas", "Yuli"),
  cita(104, "13:00:00", "14:30:00", "Camila Restrepo", "Yuli", "No asistió"),
  cita(105, "15:00:00", "17:00:00", "Valentina Ospina", "Lina"),
  cita(106, "17:30:00", "19:00:00", "Laura Mesa", "Yuli", "Confirmada"),
  cita(107, "19:30:00", "21:00:00", "Juliana Arango", "Lina", "Confirmada"),
];

/** Todas cerradas y con método: el día se puede cerrar. */
const CUENTAS_LIMPIAS: DayAccount[] = [
  cuenta(1, 101, 180_000, "efectivo", 20_000),
  cuenta(2, 102, 240_000, "transferencia"),
  cuenta(3, 103, 95_000, "efectivo", 10_000),
  cuenta(4, 105, 320_000, "transferencia", 15_000),
  cuenta(5, 106, 150_000, "otro"),
];

export function fixtureCajaView(caso: Caso): CajaView {
  const cerrado = caso === "cerrado";

  // El caso con pendientes: a la 103 nadie le cerró la cuenta y la 105 quedó
  // cobrada sin método. Las dos bloquean, por motivos distintos.
  const cuentas =
    caso === "pendientes"
      ? [
          cuenta(1, 101, 180_000, "efectivo", 20_000),
          cuenta(2, 102, 240_000, "transferencia"),
          cuenta(4, 105, 320_000, null, 15_000),
          cuenta(5, 106, 150_000, "otro"),
        ]
      : CUENTAS_LIMPIAS.map((c) => (cerrado ? { ...c, dayCloseId: 12, pushedToIngestAt: c.pushedToIngestAt } : c));

  const review = reviewDay({
    date: DIA,
    appointments: caso === "sin-agenda" ? null : CITAS,
    accounts: cuentas,
    now: AHORA,
  });

  return {
    date: DIA,
    today: DIA,
    review,
    dayClose: cerrado
      ? {
          id: 12,
          close_date: DIA,
          total_efectivo: review.totals.efectivo,
          total_transferencia: review.totals.transferencia,
          total_otro: review.totals.otro,
          total_tips: review.totals.tips,
          appointment_count: review.totals.count,
          closed_by: "usr_demo",
          closed_at: AHORA,
          pushed_to_ingest_at: null,
          created_at: AHORA,
        }
      : null,
    pendingPush: cerrado
      ? [
          {
            id: 11,
            close_date: parseEaLocalDate("2026-09-02"),
            total_efectivo: 410_000,
            total_transferencia: 120_000,
            total_otro: 0,
            total_tips: 25_000,
            appointment_count: 4,
            closed_by: "usr_demo",
            closed_at: AHORA,
            pushed_to_ingest_at: null,
            created_at: AHORA,
          },
        ]
      : [],
    // El push apagado es el estado real de hoy: la ruta JSON de pagos todavía
    // no existe en el CRM (ver `lib/ingest-client.ts`).
    pushEnabled: caso === "cerrado",
  };
}
