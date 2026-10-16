import { describe, expect, it } from "vitest";

import type { AppointmentFinance, BasisPoints } from "@/db/types";
import type { CommissionRuleInput } from "@/lib/commission";
import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import { toStrapiPayment } from "@/lib/ingest-client";
import {
  IngestPayloadError,
  buildDayClosePayments,
  buildIngestAdjustment,
  buildIngestPayment,
  type FinanceForIngest,
} from "@/lib/ingest-payload";
import {
  TicketError,
  assertTicketInvariant,
  commissionBasesOf,
  computeTicketTotals,
  houseCourtesyTicket,
  validateHouseCourtesyClose,
  type TicketItemInput,
} from "@/lib/ticket";
import type { CatalogService, TicketCatalog } from "@/components/ticket/catalog";
import { draftFromFinance, emptyDraft, isDirty, priceDraft } from "@/components/ticket/draft";
import { parseDraft } from "@/components/ticket/draft-store";
import {
  bookedVsPerformed,
  courtesyReport,
  dailyClose,
  isPaidTicket,
  varianceReport,
  type FinanceRow,
} from "@/app/(panel)/reportes/aggregate";
import { salesReport, salesTotal } from "@/app/(panel)/reportes/legacy-blend";

import {
  fortnightOf,
  planFortnight,
  toCommissionAccount,
  type CommissionAccount,
  type CommissionAccountItem,
} from "./commission-run";
import { reviewDay, summarizeDayTotals, toDayAccount, type DayAccount } from "./day-close";

/**
 * **Cortesía de la casa**, de punta a punta, en lógica pura.
 *
 * Las uñas de la dueña, de su hermana, de su pareja: la clienta paga $0 y la
 * profesional cobra su comisión completa sobre el **precio de lista**
 * (confirmado por la dueña el 2026-10-16). Antes de esta funcionalidad se
 * cerraban con el total en cero y motivo `cortesia`, y la base de comisión —lo
 * cobrado— daba cero: la técnica no cobraba nada por un trabajo que sí hizo.
 *
 * Escrito con la cabeza de `gbs-money-auditor`: los esperados están calculados
 * a mano antes de correr nada, y cada test ataca un camino por donde la plata se
 * podría escapar —la comisión, la caja, el push a Actual, los reportes—.
 *
 * Lo que necesita un MySQL de verdad (el CHECK de la `026`, la quincena pagada
 * que no se reescribe, el cierre diario que congela la cortesía) está en
 * `house-courtesy.integration.test.ts`.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const LINA = 3;
const SARA = 7;
const FORRADO = 5;
const DISENO = 31;
const COMBO = 42;

const QUINCENA = fortnightOf("2026-09-08");

const CUARENTA: CommissionRuleInput = {
  id: 1,
  eaProviderId: null,
  categoryId: null,
  eaServiceId: null,
  appliesTo: "ambos",
  kind: "percent",
  percentBp: 4000,
  fixedAmount: null,
  validFrom: "2026-01-01",
  validTo: null,
};

/**
 * La cuenta de la hermana de la dueña: forrado a 180.000 (el precio congelado
 * al agendar) y tres uñas con diseño a 10.000. Lista: 210.000.
 */
const RENGLONES: TicketItemInput[] = [
  { kind: "servicio", eaServiceId: FORRADO, pricingId: "acrylic-overlay", qty: 1, unitPriceSnapshot: 180_000 },
  { kind: "adicional", eaServiceId: DISENO, pricingId: "design-per-nail", qty: 3, unitPriceSnapshot: 10_000 },
];

let nextItemId = 9_000;

function renglonesDeCuenta(items: readonly TicketItemInput[]): CommissionAccountItem[] {
  return items.map((item) => ({
    itemId: (nextItemId += 1),
    kind: item.kind,
    eaServiceId: item.eaServiceId ?? null,
    pricingId: item.pricingId ?? null,
    qty: item.qty,
    unitPriceSnapshot: item.unitPriceSnapshot,
    lineTotal: item.qty * item.unitPriceSnapshot,
    note: item.note ?? null,
  }));
}

/** Una cuenta guardada tal como la deja `cerrarCuenta()` con la casilla puesta. */
function cortesia(over: Partial<CommissionAccount> = {}): CommissionAccount {
  const items = over.items ?? renglonesDeCuenta(RENGLONES);
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    financeId: 501,
    eaAppointmentId: 7001,
    serviceDate: parseEaLocalDate("2026-09-08"),
    closed: true,
    eaProviderId: LINA,
    secondaryEaProviderId: null,
    performedServiceId: FORRADO,
    discount: subtotal,
    amountCharged: 0,
    tip: 0,
    houseCourtesy: true,
    ...over,
    items,
  };
}

// ── La cuenta ───────────────────────────────────────────────────────────────

describe("houseCourtesyTicket — la cuenta de una cortesía", () => {
  it("cobra cero y deja los renglones a precio de lista", () => {
    const totals = houseCourtesyTicket(RENGLONES);

    expect(totals.subtotal).toBe(210_000);
    expect(totals.discount).toBe(210_000);
    expect(totals.amountCharged).toBe(0);
    expect(totals.tip).toBe(0);
    expect(totals.amountPaid).toBe(0);
    // Los renglones guardan el precio congelado; no se reescriben a cero.
    expect(totals.lines.map((line) => line.lineTotal)).toEqual([180_000, 30_000]);
    // Y la invariante de siempre se cumple sin excepciones.
    expect(() => assertTicketInvariant(totals)).not.toThrow();
  });

  it("una cortesía de un renglón en cero es válida (no hay nada que regalar)", () => {
    const totals = houseCourtesyTicket([{ kind: "manual", qty: 1, unitPriceSnapshot: 0, note: "retoque" }]);
    expect(totals.amountCharged).toBe(0);
    expect(totals.discount).toBe(0);
  });

  it("rechaza una cortesía con subtotal negativo", () => {
    // La rechaza `computeTicketTotals()`: el subtotal queda por debajo del
    // descuento de partida, que es cero.
    expect(() =>
      houseCourtesyTicket([
        { kind: "servicio", qty: 1, unitPriceSnapshot: 50_000 },
        { kind: "manual", qty: 1, unitPriceSnapshot: -80_000, note: "corrección" },
      ]),
    ).toThrow(TicketError);
  });

  it("propaga el rechazo de una cuenta mal armada", () => {
    expect(() => houseCourtesyTicket([])).toThrow(TicketError);
  });
});

describe("validateHouseCourtesyClose — lo que una cortesía no puede traer", () => {
  it("rechaza la propina en vez de descartarla en silencio", () => {
    expect(() =>
      validateHouseCourtesyClose({ items: RENGLONES, tip: 20_000, payments: [] }),
    ).toThrow(/propina/);
  });

  it("rechaza un método de pago", () => {
    expect(() =>
      validateHouseCourtesyClose({
        items: RENGLONES,
        tip: 0,
        payments: [{ method: "efectivo", amount: 210_000 }],
      }),
    ).toThrow(/no se cobra/);
  });

  it("sin propina ni pagos, es la cuenta de `houseCourtesyTicket`", () => {
    expect(validateHouseCourtesyClose({ items: RENGLONES, tip: 0, payments: [] })).toEqual(
      houseCourtesyTicket(RENGLONES),
    );
  });
});

describe("commissionBasesOf — sobre qué se paga", () => {
  it("en una cortesía, el precio de lista de cada renglón", () => {
    expect(commissionBasesOf(houseCourtesyTicket(RENGLONES), true)).toEqual([180_000, 30_000]);
  });

  it("en una cuenta normal, lo cobrado con el descuento prorrateado", () => {
    const totals = computeTicketTotals(RENGLONES, 21_000, 0);
    // 21.000 de descuento repartido 180:30 → 18.000 y 3.000.
    expect(commissionBasesOf(totals, false)).toEqual([162_000, 27_000]);
  });

  it("la propina no entra en ninguno de los dos casos", () => {
    const conPropina = computeTicketTotals(RENGLONES, 210_000, 50_000);
    expect(commissionBasesOf(conPropina, true)).toEqual([180_000, 30_000]);
    expect(commissionBasesOf(conPropina, false)).toEqual([0, 0]);
  });
});

// ── La comisión ─────────────────────────────────────────────────────────────

describe("la liquidación de una cortesía", () => {
  it("paga el 40 % del precio de lista: 72.000 + 12.000", () => {
    const plan = planFortnight({ period: QUINCENA, accounts: [cortesia()], rules: [CUARENTA] });

    expect(plan.skipped).toEqual([]);
    expect(plan.entries.map((e) => [e.eaProviderId, e.baseAmount, e.rateBp, e.amount])).toEqual([
      [LINA, 180_000, 4000, 72_000],
      [LINA, 30_000, 4000, 12_000],
    ]);
    expect(plan.totals).toEqual([
      { eaProviderId: LINA, base: 210_000, amount: 84_000, flagged: 0, appointments: 1 },
    ]);
  });

  it("es exactamente lo que pagaría la misma cuenta cobrada completa", () => {
    const cobrada = cortesia({ discount: 0, amountCharged: 210_000, houseCourtesy: false });
    const a = planFortnight({ period: QUINCENA, accounts: [cortesia()], rules: [CUARENTA] });
    const b = planFortnight({ period: QUINCENA, accounts: [cobrada], rules: [CUARENTA] });
    expect(a.totals).toEqual(b.totals);
  });

  it("sin la marca, la misma cuenta en $0 sigue pagando cero (la regla general no cambia)", () => {
    // Es el caso de antes de esta funcionalidad: total escrito en cero con
    // motivo `cortesia`. La base es lo cobrado, y lo cobrado es cero. Que
    // siga así es a propósito: solo la casilla de la dueña cambia la base.
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [cortesia({ houseCourtesy: false })],
      rules: [CUARENTA],
    });
    expect(plan.totals[0]).toMatchObject({ base: 0, amount: 0 });
  });

  it("ignora la propina aunque una fila la traiga", () => {
    // El CHECK de la `026` no deja guardar una cortesía con propina; el motor
    // igual no puede depender de eso.
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [cortesia({ tip: 50_000 })],
      rules: [CUARENTA],
    });
    expect(plan.totals[0]).toMatchObject({ base: 210_000, amount: 84_000 });
  });

  it("con dos técnicas, el combo se reparte como siempre y el adicional va a la principal", () => {
    // Combo de 250.000 al 60/40 + un retiro de 20.000. Lina: 150.000 + 20.000
    // de base → 60.000 + 8.000. Sara: 100.000 → 40.000.
    const items = renglonesDeCuenta([
      { kind: "servicio", eaServiceId: COMBO, qty: 1, unitPriceSnapshot: 250_000 },
      { kind: "adicional", eaServiceId: DISENO, qty: 1, unitPriceSnapshot: 20_000 },
    ]);
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [
        cortesia({ items, secondaryEaProviderId: SARA, performedServiceId: COMBO }),
      ],
      rules: [CUARENTA],
      combos: new Map<number, BasisPoints>([[COMBO, 6000]]),
    });

    expect(plan.totals).toEqual([
      { eaProviderId: LINA, base: 170_000, amount: 68_000, flagged: 0, appointments: 1 },
      { eaProviderId: SARA, base: 100_000, amount: 40_000, flagged: 0, appointments: 1 },
    ]);
  });

  it("con dos técnicas y sin combo, se salta igual que cualquier cuenta", () => {
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [cortesia({ secondaryEaProviderId: SARA })],
      rules: [CUARENTA],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["reparto-desconocido"]);
  });

  it("no liquida una cortesía que cobró algo: sería pagar dos veces el mismo trabajo", () => {
    const items = renglonesDeCuenta(RENGLONES);
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [cortesia({ items, discount: 110_000, amountCharged: 100_000 })],
      rules: [CUARENTA],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ reason: "cuenta-ilegible", eaAppointmentId: 7001 }),
    ]);
  });

  it("una cortesía corrupta (renglones que no cuadran) se salta como cualquier otra", () => {
    const plan = planFortnight({
      period: QUINCENA,
      accounts: [cortesia({ discount: 0 })],
      rules: [CUARENTA],
    });
    expect(plan.skipped.map((s) => s.reason)).toEqual(["total-no-cuadra"]);
  });

  it("toCommissionAccount lee la marca de la fila", () => {
    const fila = { id: 1, ea_appointment_id: 2, is_house_courtesy: 1 } as unknown as AppointmentFinance;
    const normal = { ...fila, is_house_courtesy: 0 } as AppointmentFinance;
    expect(toCommissionAccount({ ...fila, appointment_start_at: null, closed_at: null }, []).houseCourtesy).toBe(true);
    expect(toCommissionAccount({ ...normal, appointment_start_at: null, closed_at: null }, []).houseCourtesy).toBe(false);
  });
});

// ── La caja y el cierre del día ─────────────────────────────────────────────

const DIA = parseEaLocalDate("2026-09-03");
const OCHO_PM = new Date("2026-09-04T01:00:00Z");

function cuentaDelDia(over: Partial<DayAccount> & { eaAppointmentId: number }): DayAccount {
  return {
    financeId: over.eaAppointmentId + 100,
    amountCharged: 180_000,
    tip: 0,
    payments: [{ method: "efectivo", amount: 180_000 }],
    paidOn: DIA,
    eaProviderId: LINA,
    performedServiceId: FORRADO,
    closedAt: new Date("2026-09-03T15:40:00Z"),
    dayCloseId: null,
    pushedToIngestAt: null,
    ...over,
  };
}

const PAGADA = cuentaDelDia({ eaAppointmentId: 101, tip: 10_000 });
const CORTESIA = cuentaDelDia({
  eaAppointmentId: 102,
  amountCharged: 0,
  payments: [],
  paidOn: null,
  houseCourtesy: true,
});

describe("la caja del día no ve las cortesías", () => {
  it("no entran al ingreso, a las columnas por método, a las propinas ni al conteo", () => {
    expect(summarizeDayTotals([PAGADA, CORTESIA])).toEqual({
      efectivo: 180_000,
      transferencia: 0,
      otro: 0,
      sinMetodo: 0,
      tips: 10_000,
      count: 1,
      ingreso: 180_000,
      cortesias: 1,
    });
  });

  it("un día con solo cortesías tiene ingreso cero y cero cuentas", () => {
    expect(summarizeDayTotals([CORTESIA])).toMatchObject({ ingreso: 0, count: 0, cortesias: 1 });
  });

  it("una cortesía sin pagos no bloquea el cierre, como sí lo haría una cuenta sin cobrar", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [],
      accounts: [PAGADA, CORTESIA],
      now: OCHO_PM,
    });
    expect(review.issues).toEqual([]);
    expect(review.canClose).toBe(true);
    // Y sí entra a las cuentas cerradas: es lo que la congela bajo el cierre.
    expect(review.closed.map((a) => a.eaAppointmentId)).toEqual([101, 102]);

    const sinCobrar = reviewDay({
      date: DIA,
      appointments: [],
      accounts: [{ ...CORTESIA, houseCourtesy: false }],
      now: OCHO_PM,
    });
    expect(sinCobrar.canClose).toBe(false);
  });

  it.each([
    ["con monto", { amountCharged: 50_000 }],
    ["con un pago", { payments: [{ method: "efectivo" as const, amount: 1 }] }],
    ["con propina", { tip: 5_000 }],
  ])("una cortesía %s bloquea el cierre", (_caso, over) => {
    const review = reviewDay({
      date: DIA,
      appointments: [],
      accounts: [{ ...CORTESIA, ...over }],
      now: OCHO_PM,
    });
    expect(review.canClose).toBe(false);
    expect(review.issues[0]).toMatchObject({ kind: "cuenta-incompleta", blocks: true });
  });

  it("toDayAccount lee la marca de la fila", () => {
    const fila = {
      id: 1,
      ea_appointment_id: 2,
      amount_charged: 0,
      tip: 0,
      paid_at: null,
      ea_provider_id: LINA,
      performed_service_id: FORRADO,
      closed_at: new Date(),
      day_close_id: null,
      pushed_to_ingest_at: null,
      is_house_courtesy: 1,
    } as unknown as AppointmentFinance;
    expect(toDayAccount(fila).houseCourtesy).toBe(true);
    expect(toDayAccount({ ...fila, is_house_courtesy: 0 }).houseCourtesy).toBe(false);
  });
});

describe("el push a Strapi/Actual no recibe nada de una cortesía", () => {
  it("no produce ningún movimiento, ni siquiera de $0", () => {
    expect(buildIngestPayment(CORTESIA)).toEqual([]);
    // Sin monto guardado tampoco: no hay plata que mandar.
    expect(buildIngestPayment({ ...CORTESIA, amountCharged: null })).toEqual([]);
  });

  it("el lote del día lleva solo la cuenta cobrada, con su llave de siempre", () => {
    const lote = buildDayClosePayments([PAGADA, CORTESIA]);
    expect(lote.map((p) => toStrapiPayment(p))).toEqual([
      { tx_id: "ea-appt:101", paid_at: DIA, amount: 180_000, tip: 10_000, method: "efectivo" },
    ]);
    // Ninguna llave de la cortesía queda usada.
    expect(lote.some((p) => p.source_tx_id.includes("102"))).toBe(false);
  });

  it("armar el lote dos veces da el mismo lote: el reintento es idempotente", () => {
    expect(buildDayClosePayments([PAGADA, CORTESIA])).toEqual(
      buildDayClosePayments([PAGADA, CORTESIA]),
    );
  });

  it.each([
    ["con monto", { amountCharged: 50_000 } as Partial<FinanceForIngest>],
    ["con pagos", { payments: [{ method: "efectivo" as const, amount: 1 }] }],
  ])("una cortesía %s revienta el lote entero en vez de colarse", (_caso, over) => {
    expect(() => buildDayClosePayments([PAGADA, { ...CORTESIA, ...over }])).toThrow(
      IngestPayloadError,
    );
  });

  it("una cortesía no admite ajuste posterior al cierre", () => {
    expect(() => buildIngestAdjustment(CORTESIA, 50_000, 1)).toThrow(/cortesía/);
  });
});

// ── Los reportes ────────────────────────────────────────────────────────────

const at = (value: string) => parseEaLocalDateTime(value);

function fila(over: Partial<FinanceRow> = {}): FinanceRow {
  return {
    eaAppointmentId: 1,
    eaProviderId: LINA,
    secondaryEaProviderId: null,
    startAt: at("2026-09-03 09:00:00"),
    bookedServiceId: FORRADO,
    performedServiceId: FORRADO,
    snapshot: 180_000,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: 180_000,
    tip: 0,
    payments: [{ method: "efectivo", amount: 180_000 }],
    varianceReasonCode: null,
    closed: true,
    houseCourtesy: false,
    items: [
      { kind: "servicio", eaServiceId: FORRADO, pricingId: null, qty: 1, unitPrice: 180_000, lineTotal: 180_000, note: null },
    ],
    ...over,
  };
}

const FILA_CORTESIA = fila({
  eaAppointmentId: 2,
  discount: 210_000,
  amountCharged: 0,
  payments: [],
  varianceReasonCode: "cortesia",
  houseCourtesy: true,
  items: [
    { kind: "servicio", eaServiceId: FORRADO, pricingId: null, qty: 1, unitPrice: 180_000, lineTotal: 180_000, note: null },
    { kind: "adicional", eaServiceId: DISENO, pricingId: null, qty: 3, unitPrice: 10_000, lineTotal: 30_000, note: null },
  ],
});

describe("los reportes de plata excluyen las cortesías", () => {
  it("isPaidTicket: cerrada, con monto, y no cortesía", () => {
    expect(isPaidTicket(fila())).toBe(true);
    expect(isPaidTicket(FILA_CORTESIA)).toBe(false);
    expect(isPaidTicket(fila({ closed: false }))).toBe(false);
  });

  it("el cierre del día: ni ingreso, ni conteo, ni 'sin método'", () => {
    const close = dailyClose([fila(), FILA_CORTESIA], [], []);
    expect(close.revenue).toBe(180_000);
    expect(close.closedCount).toBe(1);
    // Sin el filtro la cortesía saldría como "cuenta cerrada sin método de
    // pago" y trabaría un cierre que no tiene nada pendiente.
    expect(close.withoutMethod).toBe(0);
    expect(close.blockers).toEqual([]);
    expect(close.byMethod.find((m) => m.method === "efectivo")).toMatchObject({
      amount: 180_000,
      count: 1,
    });
  });

  it("las ventas y su ticket promedio no cuentan la cortesía", () => {
    const sales = salesReport([fila(), FILA_CORTESIA], [], [], [], []);
    expect(sales.total).toBe(180_000);
    // Una cuenta, no dos: con la cortesía adentro el promedio sería 90.000.
    expect(sales.byService.reduce((n, row) => n + row.count, 0)).toBe(1);
    expect(sales.total / sales.byService[0].count).toBe(180_000);
    expect(salesTotal([fila(), FILA_CORTESIA], [])).toBe(180_000);
  });

  it("la variación de precio no la cuenta: tiene su propia línea", () => {
    expect(varianceReport([fila(), FILA_CORTESIA], []).total).toBe(0);
  });

  it("agendado vs. realizado no la lee como un cambio que perdió plata", () => {
    const cambio = { ...FILA_CORTESIA, bookedServiceId: 1 };
    expect(bookedVsPerformed([cambio], [])).toMatchObject({ comparable: 0, changed: 0 });
  });
});

describe("courtesyReport — lo que costaron las cortesías", () => {
  it("cuenta, precio de lista y comisión ya calculada", () => {
    const report = courtesyReport(
      [fila(), FILA_CORTESIA],
      [
        { eaAppointmentId: 2, amount: 72_000 },
        { eaAppointmentId: 2, amount: 12_000 },
        // La comisión de una cuenta normal no es costo de cortesía.
        { eaAppointmentId: 1, amount: 72_000 },
      ],
    );
    expect(report).toEqual({ count: 1, listPrice: 210_000, commission: 84_000, unsettled: 0 });
  });

  it("dice cuántas todavía no se liquidaron, en vez de mostrar la comisión como total", () => {
    const otra = { ...FILA_CORTESIA, eaAppointmentId: 3 };
    const report = courtesyReport([FILA_CORTESIA, otra], [{ eaAppointmentId: 2, amount: 84_000 }]);
    expect(report).toEqual({ count: 2, listPrice: 420_000, commission: 84_000, unsettled: 1 });
  });

  it("sin cortesías, todo en cero", () => {
    expect(courtesyReport([fila()], [])).toEqual({
      count: 0,
      listPrice: 0,
      commission: 0,
      unsettled: 0,
    });
  });

  it("una cortesía sin cerrar no cuenta", () => {
    expect(courtesyReport([{ ...FILA_CORTESIA, closed: false }], []).count).toBe(0);
  });
});

// ── La hoja de la cuenta ────────────────────────────────────────────────────

function servicio(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Montajes",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    servicio({ eaServiceId: FORRADO, name: "Forrado", listPrice: 85_000 }),
    servicio({ eaServiceId: DISENO, name: "Diseño por uña", listPrice: 10_000, isExtra: true }),
  ],
};

/** El precio congelado al agendar manda sobre el de hoy: 180.000, no 85.000. */
const PRECIO = { bookedServiceId: FORRADO, bookedSnapshot: 180_000 };

describe("la hoja con la casilla de cortesía", () => {
  it("valora en cero y conserva el precio de lista congelado", () => {
    const draft = { ...emptyDraft(7001, FORRADO, 0, true), extras: { [String(DISENO)]: 3 } };
    const priced = priceDraft(draft, CATALOGO, PRECIO);
    expect(priced.errors).toEqual([]);
    expect(priced.subtotal).toBe(210_000);
    expect(priced.totals?.amountCharged).toBe(0);
  });

  it("no exige motivo: la casilla es el motivo", () => {
    const draft = emptyDraft(7001, FORRADO, 0, true);
    expect(draft.varianceReasonCode).toBeNull();
    expect(priceDraft(draft, CATALOGO, PRECIO).errors).toEqual([]);
  });

  it("muestra el rechazo de la propina con el texto de lib/ticket.ts", () => {
    const draft = { ...emptyDraft(7001, FORRADO, 0, true), tip: 10_000 };
    const priced = priceDraft(draft, CATALOGO, PRECIO);
    expect(priced.errors).toEqual([expect.stringMatching(/propina/)]);
    // El total se sigue viendo: la hoja no se queda en blanco por un error.
    expect(priced.totals?.amountCharged).toBe(0);
  });

  it("una cortesía mal armada se muestra como error, sin reventar", () => {
    const draft = {
      ...emptyDraft(7001, FORRADO, 0, true),
      manual: { note: "corrección", amount: -500_000 },
    };
    const priced = priceDraft(draft, CATALOGO, PRECIO);
    expect(priced.totals).toBeNull();
    expect(priced.errors).toHaveLength(1);
  });

  it("emptyDraft arranca sin cortesía salvo que se pida", () => {
    expect(emptyDraft(1, FORRADO).houseCourtesy).toBe(false);
    expect(emptyDraft(1, FORRADO, 0, true).houseCourtesy).toBe(true);
  });

  it("marcar o desmarcar la casilla es un cambio que no se pierde al tocar afuera", () => {
    const base = emptyDraft(1, FORRADO, 0, true);
    expect(isDirty({ ...base, houseCourtesy: false }, base)).toBe(true);
    expect(isDirty(base, base)).toBe(false);
  });

  it("reabrir una cortesía guardada no la convierte en un total escrito en $0", () => {
    const draft = draftFromFinance(7001, FORRADO, {
      performedServiceId: FORRADO,
      discount: 210_000,
      tip: 0,
      amountCharged: 0,
      payments: [],
      serviceNotes: "",
      varianceReasonCode: "cortesia",
      varianceReason: "",
      houseCourtesy: true,
      items: [
        { kind: "servicio", eaServiceId: FORRADO, qty: 1, unitPrice: 180_000, note: null },
        { kind: "adicional", eaServiceId: DISENO, qty: 3, unitPrice: 10_000, note: null },
      ],
    });
    expect(draft.houseCourtesy).toBe(true);
    // Si la dueña la desmarca, la cuenta vuelve al precio de lista, no a $0.
    expect(draft.totalOverride).toBeNull();
    expect(draft.varianceReasonCode).toBeNull();
    const desmarcada = priceDraft({ ...draft, houseCourtesy: false }, CATALOGO, PRECIO);
    expect(desmarcada.totals?.amountCharged).toBe(210_000);
  });

  it("un borrador viejo sin el campo se lee como cuenta cobrada", () => {
    const viejo = {
      version: 2,
      eaAppointmentId: 1,
      performedServiceId: FORRADO,
      extras: {},
      manual: null,
      totalOverride: null,
      varianceReasonCode: null,
      varianceReason: "",
      notes: "",
      payments: [],
      tip: 0,
      updatedAt: 1,
    };
    expect(parseDraft(viejo)?.houseCourtesy).toBe(false);
    expect(parseDraft({ ...viejo, houseCourtesy: true })?.houseCourtesy).toBe(true);
    // Una verdad blanda no regala un servicio.
    expect(parseDraft({ ...viejo, houseCourtesy: "true" })?.houseCourtesy).toBe(false);
  });
});
