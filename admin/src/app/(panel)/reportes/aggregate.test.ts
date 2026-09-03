import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import {
  bookedVsPerformed,
  chairHourReport,
  customersReport,
  dailyClose,
  dailySeries,
  extrasReport,
  noShowReport,
  settlement,
  snapshotHealth,
  toVisits,
  varianceReport,
  type AppointmentRow,
  type CommissionEntryRow,
  type FinanceItemRow,
  type FinanceRow,
  type ProviderRow,
  type ServiceRow,
} from "./aggregate";

const at = (value: string) => parseEaLocalDateTime(value);
const day = (value: string) => parseEaLocalDate(value);

const PROVIDERS: ProviderRow[] = [
  { id: 7, name: "Lina" },
  { id: 8, name: "Sara" },
];

const SERVICES: ServiceRow[] = [
  { id: 1, name: "Montaje", durationMin: 150 },
  { id: 2, name: "Combo manos y pies", durationMin: 120 },
  { id: 3, name: "Press-on", durationMin: 60 },
  { id: 4, name: "Forrado", durationMin: 90 },
];

function finance(over: Partial<FinanceRow> = {}): FinanceRow {
  const items: FinanceItemRow[] = over.items ?? [
    { kind: "servicio", eaServiceId: 1, pricingId: null, qty: 1, unitPrice: 115_000, lineTotal: 115_000, note: null },
  ];
  return {
    eaAppointmentId: 1,
    eaProviderId: 7,
    secondaryEaProviderId: null,
    startAt: at("2026-08-31 09:00:00"),
    bookedServiceId: 1,
    performedServiceId: 1,
    snapshot: 115_000,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: 115_000,
    tip: 0,
    paymentMethod: "efectivo",
    varianceReasonCode: null,
    closed: true,
    ...over,
    items,
  };
}

function appointment(over: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: 1,
    start: at("2026-08-31 09:00:00"),
    end: at("2026-08-31 11:30:00"),
    status: "Completada",
    eaProviderId: 7,
    eaServiceId: 1,
    customerKey: "+573001112233",
    googleCalendarId: "evt-1",
    ...over,
  };
}

// ── 1 · Cierre del día ──────────────────────────────────────────────────────

describe("dailyClose", () => {
  it("suma el ingreso de las cuentas cerradas y reparte por método", () => {
    const result = dailyClose(
      [
        finance({ eaAppointmentId: 1, amountCharged: 115_000, tip: 10_000 }),
        finance({
          eaAppointmentId: 2,
          amountCharged: 95_000,
          paymentMethod: "transferencia",
          eaProviderId: 8,
        }),
      ],
      [appointment({ id: 1 }), appointment({ id: 2 })],
      PROVIDERS,
    );

    expect(result.revenue).toBe(210_000);
    expect(result.tips).toBe(10_000);
    expect(result.closedCount).toBe(2);
    expect(result.byMethod).toEqual([
      { method: "efectivo", label: "Efectivo", amount: 115_000, count: 1 },
      { method: "transferencia", label: "Transferencia", amount: 95_000, count: 1 },
      { method: "otro", label: "Otro", amount: 0, count: 0 },
    ]);
  });

  it("la propina va aparte del ingreso, siempre", () => {
    const result = dailyClose(
      [finance({ amountCharged: 100_000, tip: 20_000 })],
      [appointment()],
      PROVIDERS,
    );
    expect(result.revenue).toBe(100_000);
    expect(result.tips).toBe(20_000);
  });

  it("una cita atendida sin cuenta cerrada traba el cierre", () => {
    // **La compuerta es la funcionalidad**: no se cierra el día con una cita
    // completada sin cuenta.
    const result = dailyClose(
      [finance({ eaAppointmentId: 9, closed: false, amountCharged: null })],
      [appointment({ id: 9, status: "Completada" })],
      PROVIDERS,
    );
    expect(result.pendingCount).toBe(1);
    expect(result.blockers).toEqual(["1 cita atendida sin cuenta cerrada"]);
  });

  it("una cancelada o una inasistencia **no** son pendientes", () => {
    // Contarlas dejaría la compuerta trabada para siempre: no hay nada que
    // cobrar en una cita a la que nadie llegó.
    for (const status of ["Cancelada", "No asistió"]) {
      const result = dailyClose(
        [finance({ eaAppointmentId: 9, closed: false, amountCharged: null })],
        [appointment({ id: 9, status })],
        PROVIDERS,
      );
      expect(result.pendingCount, status).toBe(0);
      expect(result.blockers, status).toEqual([]);
    }
  });

  it("una cuenta cerrada sin método de pago se reporta aparte, no como «otro»", () => {
    // Sumarla a "otro" escondería un dato que falta detrás de una categoría
    // que existe.
    const result = dailyClose(
      [finance({ paymentMethod: null })],
      [appointment()],
      PROVIDERS,
    );
    expect(result.withoutMethod).toBe(1);
    expect(result.byMethod.find((m) => m.method === "otro")?.amount).toBe(0);
    expect(result.blockers).toEqual(["1 cuenta cerrada sin método de pago"]);
  });

  it("reparte por técnica, de mayor a menor", () => {
    const result = dailyClose(
      [
        finance({ eaAppointmentId: 1, eaProviderId: 7, amountCharged: 90_000 }),
        finance({ eaAppointmentId: 2, eaProviderId: 8, amountCharged: 150_000 }),
      ],
      [appointment({ id: 1 }), appointment({ id: 2 })],
      PROVIDERS,
    );
    expect(result.byProvider.map((row) => row.name)).toEqual(["Sara", "Lina"]);
  });

  it("una técnica que no está en la lista se nombra por su id, no «undefined»", () => {
    const result = dailyClose(
      [finance({ eaProviderId: 99 })],
      [appointment()],
      PROVIDERS,
    );
    expect(result.byProvider[0].name).toBe("Técnica #99");
  });

  it("una cuenta sin técnica se rotula «Sin asignar»", () => {
    const result = dailyClose(
      [finance({ eaProviderId: null })],
      [appointment()],
      PROVIDERS,
    );
    expect(result.byProvider[0].name).toBe("Sin asignar");
  });

  it("un día vacío da ceros y ningún bloqueo, no una pantalla de error", () => {
    const result = dailyClose([], [], PROVIDERS);
    expect(result).toMatchObject({
      revenue: 0,
      tips: 0,
      closedCount: 0,
      pendingCount: 0,
      blockers: [],
      byProvider: [],
    });
  });

  it("pluraliza los bloqueos", () => {
    const result = dailyClose(
      [
        finance({ eaAppointmentId: 1, closed: false, amountCharged: null }),
        finance({ eaAppointmentId: 2, closed: false, amountCharged: null }),
      ],
      [appointment({ id: 1 }), appointment({ id: 2 })],
      PROVIDERS,
    );
    expect(result.blockers[0]).toBe("2 citas atendidas sin cuenta cerrada");
  });
});

// ── 2 · Liquidación ─────────────────────────────────────────────────────────

describe("settlement", () => {
  const entry = (over: Partial<CommissionEntryRow> = {}): CommissionEntryRow => ({
    eaProviderId: 7,
    baseAmount: 100_000,
    amount: 12_000,
    commissionRuleId: 3,
    status: "pending",
    ...over,
  });

  it("suma base y comisión por técnica", () => {
    const result = settlement(
      [entry(), entry({ baseAmount: 50_000, amount: 6_000 }), entry({ eaProviderId: 8, amount: 30_000 })],
      PROVIDERS,
    );
    expect(result.totalBase).toBe(250_000);
    expect(result.totalCommission).toBe(48_000);
    expect(result.rows.map((row) => row.name)).toEqual(["Sara", "Lina"]);
    expect(result.rows.find((row) => row.name === "Lina")?.commission).toBe(18_000);
  });

  it("un renglón sin regla aplicable es **cero marcado** y se cuenta", () => {
    // `commission_rule_id = null` significa que no había regla, no que la
    // comisión sea cero. Cualquier número distinto de cero es una regla que
    // falta configurar.
    const result = settlement(
      [entry({ commissionRuleId: null, amount: 0 })],
      PROVIDERS,
    );
    expect(result.unmatched).toBe(1);
    expect(result.rows[0].unmatched).toBe(1);
  });

  it("separa lo pagado de lo pendiente", () => {
    const result = settlement(
      [entry({ status: "paid", amount: 10_000 }), entry({ status: "pending", amount: 5_000 })],
      PROVIDERS,
    );
    expect(result.rows[0].paid).toBe(10_000);
    expect(result.rows[0].pending).toBe(5_000);
  });

  it("sin renglones no inventa filas: la liquidación se calcula en Comisiones", () => {
    expect(settlement([], PROVIDERS)).toEqual({
      rows: [],
      totalBase: 0,
      totalCommission: 0,
      unmatched: 0,
    });
  });
});

// ── 3 · Rentabilidad por hora de silla ──────────────────────────────────────

describe("chairHourReport", () => {
  it("ordena por rendimiento, no por ingreso", () => {
    // Es el ejemplo textual del plan: un combo de $95k en 120 min rinde más por
    // minuto que un montaje de $115k en 150.
    const result = chairHourReport(
      [
        finance({ eaAppointmentId: 1, performedServiceId: 1, amountCharged: 115_000 }),
        finance({ eaAppointmentId: 2, performedServiceId: 2, amountCharged: 95_000 }),
      ],
      SERVICES,
    );
    expect(result.rows.map((row) => row.name)).toEqual(["Combo manos y pies", "Montaje"]);
    expect(result.rows[0].perHour).toBeCloseTo(95_000 / 2, 6);
    expect(result.rows[1].perHour).toBeCloseTo(115_000 / 2.5, 6);
  });

  it("agrupa por el servicio **realizado**, no por el agendado", () => {
    // Agrupar por el agendado diría que los press-on rinden lo que en realidad
    // rindieron los forrados.
    const result = chairHourReport(
      [finance({ bookedServiceId: 3, performedServiceId: 4, amountCharged: 90_000 })],
      SERVICES,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe("Forrado");
    expect(result.rows[0].minutes).toBe(90);
  });

  it("suma ingreso y minutos de varias cuentas del mismo servicio", () => {
    const result = chairHourReport(
      [
        finance({ eaAppointmentId: 1, performedServiceId: 1, amountCharged: 100_000 }),
        finance({ eaAppointmentId: 2, performedServiceId: 1, amountCharged: 120_000 }),
      ],
      SERVICES,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].revenue).toBe(220_000);
    expect(result.rows[0].minutes).toBe(300);
    expect(result.rows[0].tickets).toBe(2);
  });

  it("un servicio sin duración de catálogo va al final y se cuenta", () => {
    // `revenuePerChairHour` devuelve `null` con cero minutos, y
    // `chairHourRanking` manda los `null` al final. Acá solo se reporta cuántos
    // son, porque un servicio sin duración es una fila que hay que arreglar en
    // el catálogo.
    const result = chairHourReport(
      [
        finance({ eaAppointmentId: 1, performedServiceId: 1, amountCharged: 115_000 }),
        finance({ eaAppointmentId: 2, performedServiceId: 999, amountCharged: 200_000 }),
      ],
      SERVICES,
    );
    expect(result.withoutDuration).toBe(1);
    expect(result.rows[result.rows.length - 1].perHour).toBeNull();
    expect(result.rows[result.rows.length - 1].name).toBe("Servicio #999");
  });

  it("las cuentas sin cerrar no entran", () => {
    const result = chairHourReport(
      [finance({ closed: false, amountCharged: null })],
      SERVICES,
    );
    expect(result.rows).toEqual([]);
  });
});

// ── 5 · Agendado vs. realizado ──────────────────────────────────────────────

describe("bookedVsPerformed", () => {
  it("mide la tasa de cambio sobre las cuentas comparables", () => {
    const result = bookedVsPerformed(
      [
        finance({ eaAppointmentId: 1, bookedServiceId: 3, performedServiceId: 4 }),
        finance({ eaAppointmentId: 2, bookedServiceId: 1, performedServiceId: 1 }),
        finance({ eaAppointmentId: 3, bookedServiceId: 3, performedServiceId: 4 }),
        finance({ eaAppointmentId: 4, bookedServiceId: 1, performedServiceId: 1 }),
      ],
      SERVICES,
    );
    expect(result.comparable).toBe(4);
    expect(result.changed).toBe(2);
    expect(result.rate).toBe(0.5);
  });

  it("agrupa los flujos y suma su diferencia contra el precio congelado", () => {
    const result = bookedVsPerformed(
      [
        finance({
          eaAppointmentId: 1,
          bookedServiceId: 3,
          performedServiceId: 4,
          snapshot: 60_000,
          amountCharged: 90_000,
        }),
        finance({
          eaAppointmentId: 2,
          bookedServiceId: 3,
          performedServiceId: 4,
          snapshot: 60_000,
          amountCharged: 95_000,
        }),
      ],
      SERVICES,
    );
    expect(result.flows).toEqual([
      { fromId: 3, toId: 4, from: "Press-on", to: "Forrado", count: 2, delta: 65_000 },
    ]);
  });

  it("una cuenta sin servicio realizado sale del denominador", () => {
    // No dice nada sobre el cambio de servicio: dice que la cuenta no se cerró.
    const result = bookedVsPerformed(
      [
        finance({ eaAppointmentId: 1, performedServiceId: null, closed: false, amountCharged: null }),
        finance({ eaAppointmentId: 2, bookedServiceId: 3, performedServiceId: 4 }),
      ],
      SERVICES,
    );
    expect(result.comparable).toBe(1);
    expect(result.rate).toBe(1);
  });

  it("sin nada que comparar la tasa es `null`, no 0 %", () => {
    expect(bookedVsPerformed([], SERVICES)).toMatchObject({
      comparable: 0,
      changed: 0,
      rate: null,
      flows: [],
    });
  });

  it("ordena los flujos por frecuencia", () => {
    const result = bookedVsPerformed(
      [
        finance({ eaAppointmentId: 1, bookedServiceId: 1, performedServiceId: 2 }),
        finance({ eaAppointmentId: 2, bookedServiceId: 3, performedServiceId: 4 }),
        finance({ eaAppointmentId: 3, bookedServiceId: 3, performedServiceId: 4 }),
      ],
      SERVICES,
    );
    expect(result.flows[0]).toMatchObject({ from: "Press-on", to: "Forrado", count: 2 });
  });
});

// ── 6 · Adicionales ─────────────────────────────────────────────────────────

describe("extrasReport", () => {
  const withExtras = (id: number, provider: number, extra: number) =>
    finance({
      eaAppointmentId: id,
      eaProviderId: provider,
      amountCharged: 115_000 + extra,
      items: [
        { kind: "servicio", eaServiceId: 1, pricingId: null, qty: 1, unitPrice: 115_000, lineTotal: 115_000, note: null },
        { kind: "adicional", eaServiceId: null, pricingId: "design", qty: 1, unitPrice: extra, lineTotal: extra, note: null },
      ],
    });

  it("mide enganche y monto por técnica", () => {
    const result = extrasReport(
      [
        withExtras(1, 7, 24_000),
        finance({ eaAppointmentId: 2, eaProviderId: 7 }),
        withExtras(3, 8, 8_000),
        withExtras(4, 8, 8_000),
      ],
      PROVIDERS,
    );

    const lina = result.rows.find((row) => row.name === "Lina");
    const sara = result.rows.find((row) => row.name === "Sara");

    expect(lina).toMatchObject({ tickets: 2, withExtras: 1, attachRate: 0.5, amount: 24_000 });
    expect(sara).toMatchObject({ tickets: 2, withExtras: 2, attachRate: 1, amount: 16_000 });
    expect(result.total).toBe(40_000);
    expect(result.attachRate).toBe(0.75);
  });

  it("un adicional en cero no cuenta como enganche", () => {
    // Un renglón de cortesía marcado como adicional no es un adicional
    // vendido: contarlo inflaría la métrica que decide dónde entrenar.
    const result = extrasReport([withExtras(1, 7, 0)], PROVIDERS);
    expect(result.rows[0].withExtras).toBe(0);
    expect(result.rows[0].attachRate).toBe(0);
  });

  it("ordena por enganche y desempata por monto", () => {
    const result = extrasReport(
      [withExtras(1, 7, 5_000), withExtras(2, 8, 50_000), finance({ eaAppointmentId: 3, eaProviderId: 8 })],
      PROVIDERS,
    );
    expect(result.rows[0].name).toBe("Lina"); // 100 % vs 50 %
  });

  it("sin cuentas cerradas el enganche es `null`, no 0 %", () => {
    expect(extrasReport([], PROVIDERS)).toEqual({ rows: [], total: 0, attachRate: null });
  });
});

// ── 7 · Variación de precio ─────────────────────────────────────────────────

describe("varianceReport", () => {
  it("una cuenta con renglón manual no tumba la página", () => {
    // `computeTicketTotals()` **lanza** ante un renglón manual sin nota, y la
    // nota se caía en el proyector de `data.ts`. La excepción salía de un
    // Server Component, así que un solo cobro manual en el periodo dejaba
    // `/reportes` entero en error — no el reporte de variación: la página.
    //
    // Encontrado por el agente de E1 al colapsar `variance.ts`.
    const conManual = finance({
      eaAppointmentId: 99,
      eaProviderId: 7,
      amountCharged: 140_000,
      items: [
        { kind: "servicio", eaServiceId: 1, pricingId: null, qty: 1, unitPrice: 115_000, lineTotal: 115_000, note: null },
        { kind: "manual", eaServiceId: null, pricingId: null, qty: 1, unitPrice: 25_000, lineTotal: 25_000, note: "Reparación de una uña" },
      ],
    });

    expect(() => varianceReport([conManual], PROVIDERS)).not.toThrow();
  });

  const rebajada = (id: number, provider: number, charged: number, reason: FinanceRow["varianceReasonCode"]) =>
    finance({
      eaAppointmentId: id,
      eaProviderId: provider,
      amountCharged: charged,
      varianceReasonCode: reason,
    });

  it("arma la matriz técnica × motivo", () => {
    const result = varianceReport(
      [
        rebajada(1, 7, 100_000, "cortesia"),
        rebajada(2, 7, 105_000, "cortesia"),
        rebajada(3, 8, 95_000, "correccion"),
      ],
      PROVIDERS,
    );

    expect(result.total).toBe(15_000 + 10_000 + 20_000);
    expect(result.providers.map((row) => row.name)).toEqual(["Lina", "Sara"]);
    expect(result.reasons.map((row) => row.reason)).toEqual(["cortesia", "correccion"]);
    expect(
      result.cells.find((cell) => cell.eaProviderId === 7 && cell.reason === "cortesia"),
    ).toMatchObject({ amount: 25_000, count: 2 });
  });

  it("una cuenta que cobró la lista completa no aparece", () => {
    expect(varianceReport([finance()], PROVIDERS).cells).toEqual([]);
  });

  it("guarda el peor caso de una sola cuenta", () => {
    const result = varianceReport(
      [rebajada(1, 7, 100_000, "cortesia"), rebajada(2, 7, 40_000, "cortesia")],
      PROVIDERS,
    );
    expect(result.worst).toBe(75_000);
  });

  it("una variación sin motivo es un hallazgo, no una categoría", () => {
    // `validateTicketClose()` no deja cerrar una así: si aparece, la fila se
    // escribió por fuera del panel.
    const result = varianceReport([rebajada(1, 7, 90_000, null)], PROVIDERS);
    expect(result.withoutReason).toBe(1);
    expect(result.reasons.map((row) => row.reason)).toEqual(["sin-motivo"]);
    expect(result.reasons[0].label).toBe("Sin motivo");
  });

  it("solo lista los motivos que aparecen, en el orden del catálogo", () => {
    const result = varianceReport(
      [
        rebajada(1, 7, 100_000, "otro"),
        rebajada(2, 7, 100_000, "cambio_servicio"),
      ],
      PROVIDERS,
    );
    expect(result.reasons.map((row) => row.reason)).toEqual(["cambio_servicio", "otro"]);
  });

  it("un periodo sin variaciones sale en cero, no en vacío roto", () => {
    expect(varianceReport([], PROVIDERS)).toMatchObject({
      providers: [],
      reasons: [],
      cells: [],
      total: 0,
      worst: 0,
      withoutReason: 0,
    });
  });
});

// ── 8 · Clientas ────────────────────────────────────────────────────────────

describe("toVisits", () => {
  it("une EA y el histórico, que es lo que `splitCustomers` exige", () => {
    // Una llamada con solo las citas de EA contaría como nueva a media
    // clientela heredada.
    const result = toVisits(
      [appointment({ customerKey: "+573001112233" })],
      [{ customerKey: "+573001112233", at: at("2025-05-02 10:00:00"), attended: true }],
    );
    expect(result.visits).toHaveLength(2);
    expect(result.withoutKey).toBe(0);
  });

  it("solo «completada» cuenta como atendida", () => {
    // `confirmada` y `reservada` son el futuro: una cita de la semana que viene
    // no es una visita.
    for (const [status, attended] of [
      ["Completada", true],
      ["Confirmada", false],
      ["Reservada", false],
      ["Cancelada", false],
      ["No asistió", false],
    ] as const) {
      const result = toVisits([appointment({ status })], []);
      expect(result.visits[0].attended, status).toBe(attended);
    }
  });

  it("una visita sin teléfono se descarta y se cuenta aparte", () => {
    // La identidad de la clienta es el teléfono; sin él no hay forma de saber
    // si volvió, y contarla como nueva inflaría la captación.
    const result = toVisits(
      [appointment({ customerKey: null }), appointment({ id: 2, customerKey: "   " })],
      [{ customerKey: null, at: at("2025-01-01 10:00:00"), attended: true }],
    );
    expect(result.visits).toEqual([]);
    expect(result.withoutKey).toBe(3);
  });
});

describe("customersReport", () => {
  const period = { from: day("2026-08-01"), to: day("2026-08-31") };

  it("parte entre nuevas y que vuelven usando la definición de B1", () => {
    const visits = [
      { customerKey: "A", at: at("2025-11-01 10:00:00"), attended: true },
      { customerKey: "A", at: at("2026-08-05 10:00:00"), attended: true },
      { customerKey: "B", at: at("2026-08-10 10:00:00"), attended: true },
    ];
    const result = customersReport(visits, 0, period, at("2026-12-01 00:00:00"));
    expect(result.newCustomers).toBe(1);
    expect(result.returningCustomers).toBe(1);
    expect(result.newShare).toBe(0.5);
  });

  it("la retención devuelve `null` mientras haya ventanas de 60 días abiertas", () => {
    // Es la corrección H4 de `gbs-money-auditor`, y es lo que la pantalla tiene
    // que mostrar como "todavía no se puede medir" en vez de como 0 %.
    const visits = [{ customerKey: "A", at: at("2026-08-30 10:00:00"), attended: true }];
    const result = customersReport(visits, 0, period, at("2026-09-01 00:00:00"));
    expect(result.retention.pending).toBe(1);
    expect(result.retention.rate).toBeNull();
  });

  it("con la ventana vencida sí se puede medir", () => {
    const visits = [
      { customerKey: "A", at: at("2026-08-01 10:00:00"), attended: true },
      { customerKey: "A", at: at("2026-09-10 10:00:00"), attended: true },
      { customerKey: "B", at: at("2026-08-02 10:00:00"), attended: true },
    ];
    const result = customersReport(visits, 0, period, at("2026-12-01 00:00:00"));
    expect(result.retention.cohort).toBe(2);
    expect(result.retention.pending).toBe(0);
    expect(result.retention.rate).toBe(0.5);
  });

  it("un periodo sin clientas atendidas da `null`, no 0 %", () => {
    const result = customersReport([], 0, period, at("2026-12-01 00:00:00"));
    expect(result.newShare).toBeNull();
    expect(result.retention.rate).toBeNull();
  });

  it("arrastra el conteo de visitas sin teléfono para poder mostrarlo", () => {
    const result = customersReport([], 4, period, at("2026-12-01 00:00:00"));
    expect(result.withoutKey).toBe(4);
  });
});

// ── 9 · Inasistencia ────────────────────────────────────────────────────────

describe("noShowReport", () => {
  it("reparte por franja y calcula la tasa de cada una", () => {
    const result = noShowReport([
      appointment({ id: 1, start: at("2026-08-31 09:00:00"), status: "Completada" }),
      appointment({ id: 2, start: at("2026-08-31 09:30:00"), status: "No asistió" }),
      appointment({ id: 3, start: at("2026-08-31 15:00:00"), status: "Completada" }),
    ]);

    const manana = result.slots.find((slot) => slot.slot === "08-10");
    expect(manana).toMatchObject({ scheduled: 2, noShows: 1, rate: 0.5 });
    expect(result.slots.find((slot) => slot.slot === "14-16")?.rate).toBe(0);
    expect(result.rate).toBeCloseTo(1 / 3, 6);
  });

  it("una franja sin citas da `null`, no 0 %", () => {
    const result = noShowReport([
      appointment({ start: at("2026-08-31 09:00:00"), status: "Completada" }),
    ]);
    expect(result.slots.find((slot) => slot.slot === "16-18")?.rate).toBeNull();
  });

  it("una cita con estado que el panel no reconoce sale del denominador y se reporta", () => {
    // No se puede contar ni como asistida ni como inasistencia: cualquiera de
    // los dos lados falsearía la tasa.
    const result = noShowReport([
      appointment({ id: 1, status: "Pendiente" }),
      appointment({ id: 2, status: "" }),
      appointment({ id: 3, status: "Completada" }),
    ]);
    expect(result.scheduled).toBe(1);
    expect(result.unmapped).toEqual(["Pendiente", ""]);
  });

  it("la franja «fuera de horario» solo aparece si hubo algo ahí", () => {
    // Una fila vacía permanente enseña a ignorar la última fila de la tabla.
    expect(
      noShowReport([appointment({ start: at("2026-08-31 09:00:00") })]).slots.some(
        (slot) => slot.slot === "fuera",
      ),
    ).toBe(false);
    expect(
      noShowReport([appointment({ start: at("2026-08-31 06:00:00") })]).slots.some(
        (slot) => slot.slot === "fuera",
      ),
    ).toBe(true);
  });

  it("cuenta las canceladas aparte de las inasistencias", () => {
    // Cancelar con aviso es negocio normal; no asistir es la única que cuesta
    // plata. Mezclarlas fue el error que la paleta de A3 evita a propósito.
    const result = noShowReport([
      appointment({ id: 1, status: "Cancelada" }),
      appointment({ id: 2, status: "No asistió" }),
    ]);
    expect(result.cancelled).toBe(1);
    expect(result.noShows).toBe(1);
  });

  it("declara que el origen de la reserva no se puede reportar", () => {
    // `ea_appointments` no tiene ninguna columna de origen (verificado en la
    // fuente de EA 1.6.0). La pantalla lo dice en vez de fingir un proxy.
    expect(noShowReport([]).originAvailable).toBe(false);
  });

  it("un periodo vacío da `null`, no 0 %", () => {
    expect(noShowReport([]).rate).toBeNull();
  });
});

// ── Auxiliares ──────────────────────────────────────────────────────────────

describe("dailySeries", () => {
  it("da un punto por día del rango, con cero donde no hubo nada", () => {
    const days = ["2026-08-30", "2026-08-31", "2026-09-01"].map(day);
    const series = dailySeries(
      [
        finance({ eaAppointmentId: 1, startAt: at("2026-08-31 09:00:00"), amountCharged: 100_000 }),
        finance({ eaAppointmentId: 2, startAt: at("2026-08-31 14:00:00"), amountCharged: 50_000 }),
      ],
      days,
    );
    expect(series).toEqual([0, 150_000, 0]);
  });

  it("las cuentas sin cerrar y sin fecha no entran", () => {
    const days = [day("2026-08-31")];
    expect(
      dailySeries([finance({ closed: false, amountCharged: null }), finance({ startAt: null })], days),
    ).toEqual([0]);
  });
});

describe("snapshotHealth", () => {
  it("cuenta los `fallback` y los que quedaron sin precio congelado", () => {
    const result = snapshotHealth([
      finance({ snapshotSource: "fallback" }),
      finance({ snapshot: null, snapshotSource: "fallback" }),
      finance(),
    ]);
    expect(result).toEqual({ fallback: 2, withoutSnapshot: 1 });
  });
});
