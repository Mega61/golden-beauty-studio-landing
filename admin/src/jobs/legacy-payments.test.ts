import { describe, expect, it } from "vitest";

import type { EaLocalDateTime } from "@/lib/ea";

import {
  agendaproWallClock,
  applyCorrections,
  clientNameKey,
  CorrectionError,
  matchPayments,
  normalizePaymentMethod,
  parseCorrections,
  parsePaymentSheets,
  paymentTotals,
  saleIdKey,
  sheetKind,
  type LegacyCandidate,
  type ParsedPayment,
  type SourceSheet,
} from "./legacy-payments";

/**
 * Las hojas tal como las devuelve `parseXlsxSheets()`, con los encabezados
 * reales de Agenda Pro. Los nombres son inventados (TEST); nunca datos reales.
 */
const TX_HEADER = [
  "ID",
  "ID Venta",
  "Fecha",
  "Local",
  "Monto",
  "Propina",
  "Comprobante",
  "Método de Pago",
  "Cuotas",
  "Comisión",
  "Fecha de transferencia",
  "Estado de pago",
];
const SALES_HEADER = [
  "ID",
  "ID interno",
  "Fecha",
  "Monto venta",
  "Monto a pagar",
  "Monto pendiente",
  "Cliente",
  "Local",
  "Nota",
  "Creado por",
];
const ITEMS_HEADER = [
  "ID Venta",
  "Fecha venta",
  "Local",
  "Cliente",
  "Tipo item",
  "Categoría",
  "Nombre item",
  "Cantidad",
  "Precio unitario",
  "Descuento",
  "Total",
  "Prestador",
  "Fecha reserva",
];

const tx = (id: string, sale: string, fecha: string, monto: string, metodo: string, propina = "0", comprobante = "") => [
  id,
  sale,
  fecha,
  "Estudio TEST",
  monto,
  propina,
  comprobante,
  metodo,
  "",
  "",
  "",
  "-",
];
const sale = (id: string, internal: string, cliente: string, monto: string) => [
  id,
  internal,
  "19/09/2026 09:05",
  monto,
  monto,
  "0",
  cliente,
  "Estudio TEST",
  "",
  "",
];
const item = (sale: string, cliente: string, nombre: string, total: string, prestador: string, reserva: string) => [
  sale,
  "19/09/2026 09:05",
  "Estudio TEST",
  cliente,
  "Servicio",
  "Sencillos",
  nombre,
  "1",
  total,
  "0",
  total,
  prestador,
  reserva,
];

function salesBook(file: string): SourceSheet[] {
  return [
    { file, rows: [["Reporte de ventas"], ["17/09/2026 al 16/10/2026"], ["Total ventas ($)", "0"]] },
    {
      file,
      rows: [
        SALES_HEADER,
        sale("47249996", "1140", "Ana TEST _", "25000"),
        sale("47270358", "1141", "Bea Prueba", "150000"),
      ],
    },
    {
      file,
      rows: [
        ITEMS_HEADER,
        item("1140", "Ana TEST _", "Tradicional pies", "25000", "Mariana", "16/09/2026 13:00"),
        item("1141", "Bea Prueba", "Press on", "150000", "Mariana", "16/09/2026 14:00"),
      ],
    },
    {
      file,
      rows: [
        TX_HEADER,
        tx("50986137", "1140", "19/09/2026 09:05", "25000", "Efectivo"),
        tx("51008697", "1141", "19/09/2026 14:12", "150000", "Transferencia Bancaria", "5000"),
      ],
    },
  ];
}

describe("normalizePaymentMethod (el criterio del CRM)", () => {
  it.each([
    ["Efectivo", "efectivo"],
    ["EFECTIVO ", "efectivo"],
    ["Transferencia Bancaria", "transferencia"],
    ["Transferéncia", "transferencia"],
    ["Nequi", "transferencia"],
    ["Bancolombia QR", "transferencia"],
    ["Tarjeta de crédito", "otro"],
    ["-", "otro"],
    ["", "otro"],
    [null, "otro"],
  ] as const)("%s → %s", (raw, expected) => {
    expect(normalizePaymentMethod(raw)).toBe(expected);
  });
});

describe("agendaproWallClock", () => {
  it("lee día primero y no pasa por ninguna zona", () => {
    expect(agendaproWallClock("03/04/2026 09:05")).toBe("2026-04-03 09:05:00");
    expect(agendaproWallClock("2026-04-03 21:30:15")).toBe("2026-04-03 21:30:15");
    // Sin hora, mediodía: igual que el import de reservas.
    expect(agendaproWallClock("3/4/2026")).toBe("2026-04-03 12:00:00");
  });

  it("rechaza lo que no es una fecha, en vez de inventarla", () => {
    expect(agendaproWallClock("31/02/2026 10:00")).toBeNull();
    expect(agendaproWallClock("13/13/2026")).toBeNull();
    expect(agendaproWallClock("01/01/2026 24:00")).toBeNull();
    expect(agendaproWallClock("ayer")).toBeNull();
    expect(agendaproWallClock(undefined)).toBeNull();
  });
});

describe("sheetKind", () => {
  it("reconoce las hojas por sus encabezados", () => {
    expect(sheetKind(TX_HEADER)).toBe("transacciones");
    expect(sheetKind(SALES_HEADER)).toBe("ventas");
    expect(sheetKind(ITEMS_HEADER)).toBe("items");
    expect(sheetKind(["Reporte de ventas"])).toBeNull();
    expect(sheetKind(["Fecha de realización", "Servicio", "Precio real"])).toBeNull();
  });
});

describe("parsePaymentSheets", () => {
  it("junta transacción → venta → ítem por el ID interno de la venta", () => {
    const parsed = parsePaymentSheets(salesBook("ventas_2026-09-17_2026-10-16.xlsx"));
    expect(parsed.payments).toEqual([
      {
        sourceTxId: "50986137",
        saleId: "1140",
        paidAt: "2026-09-19 09:05:00",
        amount: 25_000,
        tip: 0,
        method: "efectivo",
        methodRaw: "Efectivo",
        clientName: "Ana TEST _",
        serviceName: "Tradicional pies",
        providerName: "Mariana",
        bookedAt: "2026-09-16 13:00:00",
      },
      {
        sourceTxId: "51008697",
        saleId: "1141",
        paidAt: "2026-09-19 14:12:00",
        amount: 150_000,
        tip: 5_000,
        method: "transferencia",
        methodRaw: "Transferencia Bancaria",
        clientName: "Bea Prueba",
        serviceName: "Press on",
        providerName: "Mariana",
        bookedAt: "2026-09-16 14:00:00",
      },
    ]);
    expect(parsed.withoutSale).toBe(0);
    expect(parsed.duplicates).toBe(0);
  });

  it("cuenta una sola vez el pago que llega en dos tramos y en los dos reportes", () => {
    const parsed = parsePaymentSheets([
      ...salesBook("ventas_a.xlsx"),
      ...salesBook("ventas_b.xlsx"),
      {
        file: "transacciones_a.xlsx",
        rows: [TX_HEADER, tx("50986137", "1140", "19/09/2026 09:05", "25000", "Efectivo")],
      },
    ]);
    expect(parsed.payments.map((p) => p.sourceTxId)).toEqual(["50986137", "51008697"]);
    expect(parsed.duplicates).toBe(3);
    expect(parsed.conflicts).toEqual([]);
    // El ítem repetido entre tramos no duplica el nombre del servicio.
    expect(parsed.payments[0].serviceName).toBe("Tradicional pies");
  });

  it("avisa el repetido que trae otro monto u otro método, y se queda con el primero", () => {
    const parsed = parsePaymentSheets([
      { file: "a.xlsx", rows: [TX_HEADER, tx("9", "1", "01/06/2026 10:00", "50000", "Efectivo")] },
      { file: "b.xlsx", rows: [TX_HEADER, tx("9", "1", "01/06/2026 10:00", "50000", "Nequi")] },
    ]);
    expect(parsed.conflicts).toEqual(["9"]);
    expect(parsed.payments[0].method).toBe("efectivo");
  });

  it("el método sale de «Método de Pago»; «Comprobante» solo si aquel viene vacío o en guion", () => {
    const parsed = parsePaymentSheets([
      {
        file: "t.xlsx",
        rows: [
          TX_HEADER,
          tx("1", "", "01/06/2026 10:00", "10000", "Transferencia Bancaria", "0", "Efectivo"),
          tx("2", "", "01/06/2026 10:00", "10000", "-", "0", "Efectivo"),
          tx("3", "", "01/06/2026 10:00", "10000", "", "0", ""),
        ],
      },
    ]);
    expect(parsed.payments.map((p) => [p.method, p.methodRaw])).toEqual([
      ["transferencia", "Transferencia Bancaria"],
      ["efectivo", "Efectivo"],
      ["otro", null],
    ]);
    // Sin venta en los archivos: se importa igual, y se cuenta.
    expect(parsed.withoutSale).toBe(3);
  });

  it("encuentra las columnas por encabezado aunque vengan en otro orden", () => {
    const shuffled = [...TX_HEADER].reverse();
    const row = [...tx("77", "1140", "20/09/2026 10:00", "$ 30.000", "Efectivo", "2.000")].reverse();
    const parsed = parsePaymentSheets([{ file: "t.xlsx", rows: [shuffled, row] }]);
    expect(parsed.payments[0]).toMatchObject({ sourceTxId: "77", amount: 30_000, tip: 2_000, method: "efectivo" });
  });

  it("salta y nombra las filas sin id, sin fecha o sin monto; ignora las vacías", () => {
    const parsed = parsePaymentSheets([
      {
        file: "t.xlsx",
        rows: [
          TX_HEADER,
          tx("", "1", "01/06/2026 10:00", "1000", "Efectivo"),
          tx("2", "1", "no es fecha", "1000", "Efectivo"),
          tx("3", "1", "01/06/2026 10:00", "", "Efectivo"),
          TX_HEADER.map(() => ""),
        ],
      },
    ]);
    expect(parsed.payments).toEqual([]);
    expect(parsed.skipped).toEqual([
      { reason: "sin-id", file: "t.xlsx", line: 2 },
      { reason: "sin-fecha", file: "t.xlsx", line: 3 },
      { reason: "sin-monto", file: "t.xlsx", line: 4 },
    ]);
  });

  it("varios ítems de una venta van juntos en el nombre del servicio", () => {
    const parsed = parsePaymentSheets([
      { file: "v.xlsx", rows: [SALES_HEADER, sale("1", "10", "Cami TEST", "90000")] },
      {
        file: "v.xlsx",
        rows: [
          ITEMS_HEADER,
          item("10", "Cami TEST", "Semipermanente manos", "60000", "Lina", "05/06/2026 10:00"),
          item("10", "Cami TEST", "Retiro", "30000", "Lina", "05/06/2026 10:00"),
        ],
      },
      { file: "v.xlsx", rows: [TX_HEADER, tx("5", "10", "05/06/2026 12:00", "90000", "Efectivo")] },
    ]);
    expect(parsed.payments[0].serviceName).toBe("Semipermanente manos + Retiro");
  });
});

// ---------------------------------------------------------------------------
// Casar
// ---------------------------------------------------------------------------

const at = (value: string) => value as EaLocalDateTime;

function payment(partial: Partial<ParsedPayment> & { sourceTxId: string }): ParsedPayment {
  return {
    saleId: partial.sourceTxId,
    paidAt: at("2026-09-19 10:00:00"),
    amount: 50_000,
    tip: 0,
    method: "efectivo",
    methodRaw: "Efectivo",
    clientName: "Ana TEST",
    serviceName: "Tradicional pies",
    providerName: "Mariana",
    bookedAt: at("2026-09-16 13:00:00"),
    ...partial,
  };
}

function legacy(partial: Partial<LegacyCandidate> & { id: number }): LegacyCandidate {
  return {
    start: at("2026-09-16 13:00:00"),
    clientName: "Ana TEST",
    serviceName: "Tradicional pies",
    amountCharged: 50_000,
    ...partial,
  };
}

describe("clientNameKey", () => {
  it("borra tildes, signos y rellenos del apellido", () => {
    expect(clientNameKey("  Ána  TEST _ ")).toBe("ana test");
    expect(clientNameKey("José N/A")).toBe("jose");
    expect(clientNameKey(null)).toBe("");
  });
});

describe("matchPayments", () => {
  it("regla fuerte: misma fecha de reserva al minuto y mismo nombre (con el relleno «_» borrado)", () => {
    const result = matchPayments(
      [payment({ sourceTxId: "1", clientName: "Ana TEST _" })],
      [legacy({ id: 10, clientName: "Bea Otra" }), legacy({ id: 11 })],
    );
    expect(result.links.get("1")).toBe(11);
    expect(result.byRule).toEqual({ reserva: 1, respaldo: 0 });
    expect(result.unmatched).toBe(0);
  });

  it("con el nombre completo distinto, casa por nombre de pila solo si hay una sola así en ese minuto", () => {
    const one = matchPayments(
      [payment({ sourceTxId: "1", clientName: "Ana María TEST" })],
      [legacy({ id: 11, clientName: "Ana T." }), legacy({ id: 12, clientName: "Bea Otra" })],
    );
    expect(one.links.get("1")).toBe(11);

    const two = matchPayments(
      [payment({ sourceTxId: "1", clientName: "Ana María TEST", amount: 1 })],
      [legacy({ id: 11, clientName: "Ana T." }), legacy({ id: 12, clientName: "Ana R." })],
    );
    // Dos Anas a la misma hora: no se adivina, y el respaldo no aplica porque
    // el monto no coincide con ninguna.
    expect(two.links.get("1")).toBeNull();
    expect(two.unmatched).toBe(1);
    expect(two.unmatchedAmount).toBe(1);
  });

  it("respaldo: mismo día, monto y servicio, y una sola cita así", () => {
    const result = matchPayments(
      [payment({ sourceTxId: "1", clientName: "Otro Nombre", bookedAt: at("2026-09-16 15:00:00") })],
      [legacy({ id: 11, start: at("2026-09-16 09:00:00") }), legacy({ id: 12, start: at("2026-09-17 15:00:00") })],
    );
    expect(result.links.get("1")).toBe(11);
    expect(result.byRule).toEqual({ reserva: 0, respaldo: 1 });
  });

  it("respaldo sin fecha de reserva usa el día del pago; y no adivina entre dos iguales", () => {
    const one = matchPayments(
      [payment({ sourceTxId: "1", bookedAt: null, paidAt: at("2026-09-16 18:00:00"), clientName: null })],
      [legacy({ id: 11 })],
    );
    expect(one.links.get("1")).toBe(11);

    const two = matchPayments(
      [payment({ sourceTxId: "1", bookedAt: null, paidAt: at("2026-09-16 18:00:00"), clientName: null })],
      [legacy({ id: 11 }), legacy({ id: 12, start: at("2026-09-16 16:00:00") })],
    );
    expect(two.links.get("1")).toBeNull();
  });

  it("un pago sin servicio no casa por respaldo", () => {
    const result = matchPayments(
      [payment({ sourceTxId: "1", bookedAt: null, serviceName: null })],
      [legacy({ id: 11, start: at("2026-09-19 10:00:00") })],
    );
    expect(result.links.get("1")).toBeNull();
  });

  it("los pagos de una misma venta (pago dividido) van a la misma cita, y el respaldo compara la suma", () => {
    const result = matchPayments(
      [
        payment({ sourceTxId: "1", saleId: "S", amount: 30_000, clientName: "Nadie", bookedAt: null, paidAt: at("2026-09-16 15:00:00") }),
        payment({ sourceTxId: "2", saleId: "S", amount: 20_000, method: "transferencia", clientName: "Nadie", bookedAt: null, paidAt: at("2026-09-16 15:00:00") }),
      ],
      [legacy({ id: 11 })],
    );
    expect(result.links.get("1")).toBe(11);
    expect(result.links.get("2")).toBe(11);
    expect(result.matched).toBe(2);
  });

  it("una cita se enlaza a una sola venta, y la regla fuerte gana sobre el respaldo", () => {
    // La venta A solo casaría por respaldo; la B la reclama por reserva y
    // nombre. Aunque A venga primero, la cita es de B.
    const result = matchPayments(
      [
        payment({ sourceTxId: "A", clientName: "Otra Persona", bookedAt: null, paidAt: at("2026-09-16 18:00:00") }),
        payment({ sourceTxId: "B" }),
      ],
      [legacy({ id: 11 })],
    );
    expect(result.links.get("B")).toBe(11);
    expect(result.links.get("A")).toBeNull();
    expect(result).toMatchObject({ matched: 1, unmatched: 1, unmatchedAmount: 50_000 });
  });

  it("sin historial de reservas, nada casa y todo se cuenta", () => {
    const result = matchPayments([payment({ sourceTxId: "1" }), payment({ sourceTxId: "2" })], []);
    expect(result).toMatchObject({ matched: 0, unmatched: 2, unmatchedAmount: 100_000 });
  });
});

describe("saleIdKey", () => {
  it("la misma venta con y sin numeral es la misma", () => {
    expect(saleIdKey("#1003")).toBe("1003");
    expect(saleIdKey(" # 1003 ")).toBe("1003");
    expect(saleIdKey("1003")).toBe("1003");
    expect(saleIdKey("")).toBeNull();
    expect(saleIdKey(undefined)).toBeNull();
  });

  it("junta transacción y venta aunque una traiga «#» y la otra no", () => {
    const parsed = parsePaymentSheets([
      { file: "v.xlsx", rows: [SALES_HEADER, sale("1", "#1003", "Cami TEST", "150000")] },
      { file: "v.xlsx", rows: [ITEMS_HEADER, item("#1003", "Cami TEST", "Press on", "150000", "Lina", "01/06/2026 10:00")] },
      { file: "t.xlsx", rows: [TX_HEADER, tx("44677489", "1003", "01/06/2026 16:47", "150000", "Transferencia Bancaria")] },
    ]);
    expect(parsed.withoutSale).toBe(0);
    expect(parsed.payments[0]).toMatchObject({ saleId: "1003", serviceName: "Press on" });
  });
});

describe("parseCorrections", () => {
  it("lee las tres clases de corrección", () => {
    const corrections = parseCorrections({
      _doc: "solo ids",
      tx: {
        "1": { sale: "10", method: "efectivo" },
        "2": { sale: "11", split: [{ method: "efectivo", amount: 150_000 }, { method: "transferencia", amount: 10_000 }] },
        "3": { sale: "12", courtesy: true },
      },
    });
    expect(corrections.get("1")).toEqual({ sale: "10", method: "efectivo", courtesy: false });
    expect(corrections.get("2")?.split).toHaveLength(2);
    expect(corrections.get("3")).toEqual({ sale: "12", courtesy: true });
  });

  it.each([
    ["sin `tx`", {}],
    ["un medio que no existe", { tx: { "1": { method: "tarjeta" } } }],
    ["un id que no es número", { tx: { abc: { courtesy: true } } }],
    ["medio y partes a la vez", { tx: { "1": { method: "efectivo", split: [{ method: "efectivo", amount: 1 }, { method: "otro", amount: 1 }] } } }],
    ["un pago partido en una sola parte", { tx: { "1": { split: [{ method: "efectivo", amount: 1 }] } } }],
    ["un monto con decimales", { tx: { "1": { split: [{ method: "efectivo", amount: 1.5 }, { method: "otro", amount: 1 }] } } }],
    ["un campo que no se conoce (¿un nombre?)", { tx: { "1": { cliente: "Ana" } } }],
  ])("rechaza el archivo con %s", (_, json) => {
    expect(() => parseCorrections(json)).toThrow(CorrectionError);
  });
});

describe("applyCorrections", () => {
  const base = [
    payment({ sourceTxId: "1", saleId: "10", method: "transferencia", amount: 50_000 }),
    payment({ sourceTxId: "2", saleId: "11", method: "transferencia", amount: 160_000, tip: 5_000 }),
    payment({ sourceTxId: "3", saleId: "12", method: "efectivo", amount: 70_000 }),
    payment({ sourceTxId: "4", saleId: "13", method: "efectivo", amount: 30_000 }),
  ];

  it("sin correcciones, todo queda como lo dijo Agenda Pro", () => {
    const { rows, report } = applyCorrections(base);
    expect(rows.map((row) => [row.sourceTxId, row.part, row.method, row.methodAgendapro, row.isCourtesy])).toEqual([
      ["1", 0, "transferencia", "transferencia", false],
      ["2", 0, "transferencia", "transferencia", false],
      ["3", 0, "efectivo", "efectivo", false],
      ["4", 0, "efectivo", "efectivo", false],
    ]);
    expect(report).toEqual({ methodChanged: 0, split: 0, courtesy: 0, notFound: [], saleMismatch: [] });
  });

  it("guarda el medio real y el de Agenda Pro; parte el pago exacto; marca la cortesía", () => {
    const { rows, report } = applyCorrections(
      base,
      parseCorrections({
        tx: {
          "1": { sale: "10", method: "efectivo" },
          "2": { sale: "11", split: [{ method: "efectivo", amount: 150_000 }, { method: "transferencia", amount: 10_000 }] },
          "3": { sale: "#12", courtesy: true },
          "99": { sale: "999", courtesy: true },
        },
      }),
    );
    expect(rows.map((row) => [row.sourceTxId, row.part, row.amount, row.tip, row.method, row.methodAgendapro, row.isCourtesy])).toEqual([
      ["1", 0, 50_000, 0, "efectivo", "transferencia", false],
      // La propina va entera con la primera parte.
      ["2", 0, 150_000, 5_000, "efectivo", "transferencia", false],
      ["2", 1, 10_000, 0, "transferencia", "transferencia", false],
      ["3", 0, 70_000, 0, "efectivo", "efectivo", true],
      ["4", 0, 30_000, 0, "efectivo", "efectivo", false],
    ]);
    expect(report).toEqual({ methodChanged: 2, split: 1, courtesy: 1, notFound: ["99"], saleMismatch: [] });
    // El total de la venta partida es exacto.
    expect(rows.filter((row) => row.sourceTxId === "2").reduce((sum, row) => sum + row.amount, 0)).toBe(160_000);
  });

  it("una corrección del medio que ya era el de Agenda Pro no cuenta como cambio", () => {
    const { report } = applyCorrections(base, parseCorrections({ tx: { "3": { method: "efectivo" } } }));
    expect(report.methodChanged).toBe(0);
  });

  it("avisa la corrección cuya venta no es la del archivo", () => {
    const { report } = applyCorrections(base, parseCorrections({ tx: { "1": { sale: "77", method: "efectivo" } } }));
    expect(report.saleMismatch).toEqual(["1"]);
  });

  it("no importa un pago partido que no suma el monto de Agenda Pro", () => {
    expect(() =>
      applyCorrections(
        base,
        parseCorrections({
          tx: { "2": { split: [{ method: "efectivo", amount: 150_000 }, { method: "transferencia", amount: 9_000 }] } },
        }),
      ),
    ).toThrow(CorrectionError);
  });
});

describe("paymentTotals", () => {
  it("bruto, cortesías, neto y neto por medio real, en total y por mes; la propina va aparte", () => {
    const { rows } = applyCorrections(
      [
        payment({ sourceTxId: "1", paidAt: at("2026-06-30 19:00:00"), amount: 40_000, tip: 5_000 }),
        payment({ sourceTxId: "2", paidAt: at("2026-07-01 09:00:00"), amount: 160_000, method: "transferencia" }),
        payment({ sourceTxId: "3", paidAt: at("2026-07-02 09:00:00"), amount: 10_000, method: "otro" }),
        payment({ sourceTxId: "4", paidAt: at("2026-07-03 09:00:00"), amount: 90_000, method: "efectivo" }),
      ],
      parseCorrections({
        tx: {
          "2": { split: [{ method: "efectivo", amount: 150_000 }, { method: "transferencia", amount: 10_000 }] },
          "4": { courtesy: true },
        },
      }),
    );
    const totals = paymentTotals(rows);
    expect(totals).toEqual({
      transactions: 4,
      gross: 300_000,
      courtesy: { transactions: 1, amount: 90_000 },
      net: 210_000,
      tips: 5_000,
      netByMethod: { efectivo: 190_000, transferencia: 10_000, otro: 10_000 },
      byMonth: [
        { month: "2026-06", transactions: 1, gross: 40_000, courtesy: 0, net: 40_000, tips: 5_000, netByMethod: { efectivo: 40_000, transferencia: 0, otro: 0 } },
        { month: "2026-07", transactions: 3, gross: 260_000, courtesy: 90_000, net: 170_000, tips: 0, netByMethod: { efectivo: 150_000, transferencia: 10_000, otro: 10_000 } },
      ],
    });
    // Neto por medio suma el neto, al peso.
    expect(Object.values(totals.netByMethod).reduce((a, b) => a + b, 0)).toBe(totals.net);
  });
});
