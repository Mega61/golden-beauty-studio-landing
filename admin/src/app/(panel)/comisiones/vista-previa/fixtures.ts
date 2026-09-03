import type { CommissionEntryDetail } from "@/db/repositories/commission-entry";
import type { CommissionRun, CommissionRunStatus } from "@/db/types";
import { fortnightBlockers, fortnightOf } from "@/jobs/commission-run";
import { parseEaLocalDate } from "@/lib/ea";

import type { ComisionesView } from "../data";
import {
  buildSettlements,
  settlementsBase,
  settlementsTotal,
  type SettlementNames,
} from "../settlement";

/**
 * Quincenas de mentira para revisar la pantalla sin MySQL ni EA.
 *
 * Los cinco casos son estados distintos de la misma pantalla, y los que
 * importan son los del medio: **una quincena con bloqueos** (no se puede
 * revisar), y **una ya pagada** (de solo lectura, con el aviso de que no se
 * ajusta). Una quincena limpia se ve bien por accidente.
 *
 * Los datos entran por el mismo borde por el que entrarían los de verdad: filas
 * de `commission_entry` pasadas por `buildSettlements()`, la misma función que
 * usa la pantalla real. Un fixture que fabricara los totales a mano podría
 * mostrar una combinación que el agrupador nunca produce, y entonces lo que se
 * estaría revisando es un dibujo.
 *
 * Las cifras son las de la quincena de referencia de `commission-run.test.ts`,
 * calculadas a mano: Lina 227.600 y Sara 40.000.
 */

export const CASOS = ["bloqueada", "lista", "pagada", "vacia", "tecnica"] as const;
export type Caso = (typeof CASOS)[number];

export function parseCaso(raw: string | undefined): Caso {
  return CASOS.includes(raw as Caso) ? (raw as Caso) : "bloqueada";
}

const LINA = 3;
const SARA = 7;
const QUINCENA = fortnightOf("2026-09-08");

const NOMBRES: SettlementNames = {
  providers: new Map([
    [LINA, "Lina Restrepo"],
    [SARA, "Sara Mejía"],
  ]),
  services: new Map([
    [5, "Forrado en acrílico"],
    [9, "Montaje en acrílico esculpido"],
    [31, "Diseño por uña"],
    [42, "Combo manos y pies"],
  ]),
};

let seq = 0;

function entrada(
  over: Partial<CommissionEntryDetail> & { eaAppointmentId: number; day: string },
): CommissionEntryDetail {
  seq += 1;
  const [year, month, day] = over.day.split("-").map(Number);
  return {
    entryId: seq,
    eaProviderId: LINA,
    commissionRuleId: 1,
    baseAmount: 100_000,
    rateBp: 4000,
    amount: 40_000,
    status: "pending",
    commissionRunId: 1,
    periodStart: QUINCENA.periodStart,
    periodEnd: QUINCENA.periodEnd,
    itemId: seq * 10,
    itemKind: "servicio",
    eaServiceId: 5,
    pricingId: null,
    qty: 1,
    note: null,
    financeId: 600 + seq,
    appointmentStartAt: new Date(year, month - 1, day, 10, 0, 0),
    ...over,
  };
}

/** Las ocho entradas de la quincena de referencia. */
function entradas(): CommissionEntryDetail[] {
  return [
    // A · forrado + 3 diseños
    entrada({ eaAppointmentId: 5001, day: "2026-09-02", baseAmount: 180_000, amount: 72_000 }),
    entrada({
      eaAppointmentId: 5001,
      day: "2026-09-02",
      itemKind: "adicional",
      eaServiceId: 31,
      qty: 3,
      baseAmount: 24_000,
      amount: 9_600,
    }),
    // B · montaje + adicional, con descuento prorrateado
    entrada({
      eaAppointmentId: 5002,
      day: "2026-09-05",
      eaServiceId: 9,
      baseAmount: 190_698,
      amount: 76_279,
    }),
    entrada({
      eaAppointmentId: 5002,
      day: "2026-09-05",
      itemKind: "adicional",
      eaServiceId: 31,
      baseAmount: 14_302,
      amount: 5_721,
    }),
    // C · el combo a cuatro manos: el mismo renglón, dos técnicas
    entrada({
      eaAppointmentId: 5003,
      day: "2026-09-08",
      eaServiceId: 42,
      baseAmount: 150_000,
      amount: 60_000,
    }),
    entrada({
      eaAppointmentId: 5003,
      day: "2026-09-08",
      eaServiceId: 42,
      eaProviderId: SARA,
      baseAmount: 100_000,
      amount: 40_000,
    }),
    entrada({
      eaAppointmentId: 5003,
      day: "2026-09-08",
      itemKind: "adicional",
      eaServiceId: 31,
      baseAmount: 10_000,
      amount: 4_000,
    }),
    // D · retoque de garantía: cero marcado
    entrada({
      eaAppointmentId: 5004,
      day: "2026-09-10",
      eaProviderId: SARA,
      itemKind: "manual",
      eaServiceId: null,
      commissionRuleId: null,
      rateBp: null,
      baseAmount: 0,
      amount: 0,
      note: "Retoque de garantía",
    }),
  ];
}

function liquidacion(
  eaProviderId: number,
  total: number,
  status: CommissionRunStatus,
): CommissionRun {
  return {
    id: eaProviderId,
    ea_provider_id: eaProviderId,
    period_start: QUINCENA.periodStart,
    period_end: QUINCENA.periodEnd,
    total,
    status,
    reviewed_by: status === "borrador" ? null : "usr_owner",
    reviewed_at: status === "borrador" ? null : new Date(2026, 8, 16, 9, 0, 0),
    paid_by: status === "pagada" ? "usr_owner" : null,
    paid_at: status === "pagada" ? new Date(2026, 8, 16, 9, 30, 0) : null,
    created_at: new Date(2026, 8, 16, 8, 0, 0),
    updated_at: new Date(2026, 8, 16, 9, 30, 0),
  };
}

export function fixtureComisionesView(caso: Caso): ComisionesView {
  seq = 0;

  const propia = caso === "tecnica";
  // En `lista` y `pagada` la quincena ya pasó la compuerta, y la compuerta no
  // deja revisar con un renglón sin regla: el retoque marcado no puede seguir
  // ahí. Un banco de pruebas que muestre un estado imposible es un banco de
  // pruebas que valida una pantalla que nunca se va a ver.
  const revisada = caso === "lista" || caso === "pagada";
  const filas =
    caso === "vacia"
      ? []
      : entradas().filter((row) => !revisada || row.commissionRuleId !== null);
  const entries = propia ? filas.filter((row) => row.eaProviderId === SARA) : filas;

  const runs =
    caso === "vacia"
      ? []
      : caso === "pagada"
        ? [liquidacion(LINA, 227_600, "pagada"), liquidacion(SARA, 40_000, "borrador")]
        : caso === "lista"
          ? [liquidacion(LINA, 227_600, "revisada"), liquidacion(SARA, 40_000, "revisada")]
          : [liquidacion(LINA, 227_600, "borrador"), liquidacion(SARA, 40_000, "borrador")];

  const settlements = buildSettlements(
    entries,
    propia ? runs.filter((run) => run.ea_provider_id === SARA) : runs,
    NOMBRES,
  );

  // La compuerta se arma con la misma función que en producción: dos días sin
  // cierre de caja y el renglón marcado del retoque.
  const assessment = {
    period: QUINCENA,
    missingDayCloses:
      caso === "bloqueada"
        ? [parseEaLocalDate("2026-09-04"), parseEaLocalDate("2026-09-11")]
        : [],
    flaggedEntries: caso === "bloqueada" ? 1 : 0,
    open: false,
  };

  return {
    period: QUINCENA,
    current: QUINCENA,
    previous: fortnightOf("2026-08-20"),
    next: null,
    settlements,
    total: settlementsTotal(settlements),
    base: settlementsBase(settlements),
    pending:
      caso === "bloqueada"
        ? [
            {
              eaAppointmentId: 5010,
              date: "2026-09-09",
              amountCharged: 260_000,
              provider: "Lina Restrepo",
            },
          ]
        : [],
    assessment,
    blockers: fortnightBlockers(assessment),
    scope: propia ? "propia" : "todas",
    canAdmin: !propia,
    unlinked: false,
    eaFailure: null,
  };
}
