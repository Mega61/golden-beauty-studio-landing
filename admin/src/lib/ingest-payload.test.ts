import { describe, expect, it } from "vitest";

import {
  IngestPayloadError,
  PAYMENT_METHODS,
  buildDayClosePayments,
  buildIngestAdjustment,
  buildIngestPayment,
  isPaymentMethod,
  type FinanceForIngest,
} from "./ingest-payload";

import type { PaymentMethod } from "@/db/types";

/**
 * ⚠ Los **nombres de campo** de `IngestPayment` son provisionales: hay que
 * confirmarlos contra `src/api/visit/services/ingest.ts` del CRM, que no está
 * disponible desde este repo. Lo que estos tests sí fijan es lo que el plan sí
 * fija: enum de método, monto entero sin propina adentro, fecha en base caja, e
 * ids que salen de `lib/ingest-id.ts` y de ningún otro lado.
 */

/**
 * La cuenta de prueba.
 *
 * `paymentMethod` es una comodidad de estos tests, no un campo del tipo: arma un
 * pago único por todo lo cobrado, que es el 95 % de las cuentas. `null` deja la
 * cuenta sin cobrar. Para una cuenta partida se pasa `payments` directo.
 */
const AMOUNT = 130_000;

const finance = (
  over: Partial<FinanceForIngest> & { paymentMethod?: PaymentMethod | null } = {},
): FinanceForIngest => {
  const { paymentMethod, ...rest } = over;
  const charged = rest.amountCharged === undefined ? AMOUNT : rest.amountCharged;

  return {
  eaAppointmentId: 42,
  amountCharged: AMOUNT,
  tip: 10_000,
  paidOn: "2026-08-31",
  eaProviderId: 2,
  performedServiceId: 12,
  payments:
    paymentMethod === null
      ? []
      : [{ method: paymentMethod ?? "efectivo", amount: charged ?? 0 }],
  ...rest,
  };
};

describe("buildIngestPayment", () => {
  it("arma el pago de una cita cerrada", () => {
    // Los cinco campos que `Payment` tiene en Strapi, y ni uno más: mandar
    // `source`, `ea_appointment_id` o `imported_id` era mandar columnas que el
    // content type no tiene.
    expect(buildIngestPayment(finance())).toEqual([
      {
        source_tx_id: "ea-appt:42",
        amount: 130_000,
        tip: 10_000,
        method: "efectivo",
        paid_on: "2026-08-31",
      },
    ]);
  });

  it("la propina viaja al lado del monto, nunca sumada", () => {
    // Meterla adentro inflaría el ingreso del mes con plata que es de la
    // técnica, y ese error no se ve hasta que alguien compara con la caja.
    const pago = buildIngestPayment(finance({ amountCharged: 100_000, tip: 50_000 }))[0];

    expect(pago.amount).toBe(100_000);
    expect(pago.tip).toBe(50_000);
  });

  it("un método fuera del enum de Strapi no sale del panel", () => {
    // Mandarlo produciría un 400 en mitad del push del día, con medio cierre
    // adentro de Actual y medio afuera.
    expect(() =>
      buildIngestPayment(finance({ paymentMethod: "datafono" as PaymentMethod })),
    ).toThrow(/Método de pago desconocido/);
  });

  it("los tres métodos válidos pasan", () => {
    for (const method of PAYMENT_METHODS) {
      expect(buildIngestPayment(finance({ paymentMethod: method }))[0].method).toBe(method);
    }
  });

  it("una cuenta sin cerrar no se puede empujar", () => {
    expect(() => buildIngestPayment(finance({ amountCharged: null }))).toThrow(/cuenta cerrada/);
  });

  it("una cita sin método de pago tampoco", () => {
    expect(() => buildIngestPayment(finance({ paymentMethod: null }))).toThrow(/método de pago/);
  });

  it("la fecha de caja tiene que ser una fecha de calendario", () => {
    // Base caja = base servicio: se cobra siempre el mismo día. Un instante con
    // hora y zona correría la transacción de día en Actual.
    expect(() => buildIngestPayment(finance({ paidOn: null }))).toThrow(/fecha de caja/);
    expect(() => buildIngestPayment(finance({ paidOn: "2026-08-31T14:00:00Z" }))).toThrow(
      /fecha de caja/,
    );
    expect(() => buildIngestPayment(finance({ paidOn: "31/08/2026" }))).toThrow(/fecha de caja/);
  });

  it("rechaza centavos en el monto y en la propina", () => {
    expect(() => buildIngestPayment(finance({ amountCharged: 1_000.5 }))).toThrow(/monto/);
    expect(() => buildIngestPayment(finance({ tip: 0.5 }))).toThrow(/propina/);
  });

  it("un cobro de cero es válido: la cortesía existe", () => {
    expect(buildIngestPayment(finance({ amountCharged: 0, tip: 0 }))[0].amount).toBe(0);
  });
});

describe("buildIngestAdjustment — corregir después del cierre", () => {
  it("el ajuste lleva id propio y el delta, no el total nuevo", () => {
    // Actual importa el ajuste como movimiento aparte y lo suma al que ya
    // tiene. Mandar el total nuevo duplicaría el ingreso de esa cita.
    expect(buildIngestAdjustment(finance(), -15_000, 1)).toEqual({
      source_tx_id: "ea-appt:42:adj1",
      amount: -15_000,
      tip: 0,
      method: "efectivo",
      paid_on: "2026-08-31",
    });
  });

  it("el ajuste nunca reusa la llave del pago original", () => {
    // `Payment.tx_id` es UNIQUE y `upsertPayment()` llavea por ahí: un ajuste
    // que la reusara no crearía un movimiento, le PISARÍA el monto al pago —
    // y el ingreso del día quedaría corto por el monto original, en silencio.
    const pago = buildIngestPayment(finance())[0];
    const ajuste = buildIngestAdjustment(finance(), 5_000, 1);

    expect(ajuste.source_tx_id).not.toBe(pago.source_tx_id);
  });

  it("dos ajustes de la misma cita son dos filas distintas", () => {
    expect(buildIngestAdjustment(finance(), 1_000, 1).source_tx_id).not.toBe(
      buildIngestAdjustment(finance(), 2_000, 2).source_tx_id,
    );
  });

  it("no se re-empuja la propina con el ajuste", () => {
    expect(buildIngestAdjustment(finance({ tip: 10_000 }), 5_000, 1).tip).toBe(0);
  });

  it("un ajuste de cero no se empuja", () => {
    expect(() => buildIngestAdjustment(finance(), 0, 1)).toThrow(/es de cero/);
  });

  it("rechaza centavos en el delta", () => {
    expect(() => buildIngestAdjustment(finance(), 1_000.5, 1)).toThrow(/ajuste de la cita/);
  });

  it("hereda las validaciones del pago", () => {
    expect(() => buildIngestAdjustment(finance({ paymentMethod: null }), 1_000, 1)).toThrow(
      IngestPayloadError,
    );
  });
});

describe("buildDayClosePayments", () => {
  it("arma el lote entero antes de mandar nada", () => {
    const pagos = buildDayClosePayments([
      finance({ eaAppointmentId: 1 }),
      finance({ eaAppointmentId: 2 }),
      finance({ eaAppointmentId: 3 }),
    ]);

    expect(pagos.map((p) => p.source_tx_id)).toEqual([
      "ea-appt:1",
      "ea-appt:2",
      "ea-appt:3",
    ]);
  });

  it("una sola cuenta mala tumba el lote completo", () => {
    // Media docena de transacciones en Actual y un error a la mitad es un
    // estado del que hay que salir a mano, una por una.
    expect(() =>
      buildDayClosePayments([finance({ eaAppointmentId: 1 }), finance({ amountCharged: null })]),
    ).toThrow(IngestPayloadError);
  });

  it("un cierre sin cuentas es un lote vacío, no un error", () => {
    expect(buildDayClosePayments([])).toEqual([]);
  });
});

describe("isPaymentMethod", () => {
  it("acepta exactamente los tres del enum de Strapi", () => {
    expect(PAYMENT_METHODS).toEqual(["efectivo", "transferencia", "otro"]);

    for (const method of PAYMENT_METHODS) {
      expect(isPaymentMethod(method)).toBe(true);
    }
  });

  it("rechaza todo lo demás", () => {
    for (const value of ["Efectivo", "tarjeta", "", null, undefined, 1, {}]) {
      expect(isPaymentMethod(value)).toBe(false);
    }
  });
});

describe("la cuenta partida entre dos métodos", () => {
  const partida = (over: Partial<FinanceForIngest> = {}) =>
    finance({
      amountCharged: 100_000,
      payments: [
        { method: "efectivo", amount: 60_000 },
        { method: "transferencia", amount: 40_000 },
      ],
      ...over,
    });

  it("sale como dos movimientos, uno por método", () => {
    // La plata aterrizó en dos lugares —el cajón y el banco— y Actual Budget
    // los quiere separados, o ninguna de las dos conciliaciones cuadra.
    const pagos = buildIngestPayment(partida());

    expect(pagos).toHaveLength(2);
    expect(pagos.map((p) => p.method)).toEqual(["efectivo", "transferencia"]);
    expect(pagos.map((p) => p.amount)).toEqual([60_000, 40_000]);
  });

  it("cada movimiento lleva el método en su llave, y no la llave pelada", () => {
    // La llave pelada es la de las filas que **ya están** en Strapi y en Actual.
    // Reusarla acá dejaría dos movimientos con el mismo tx_id: el segundo le
    // pisaría el monto al primero, sin error visible.
    expect(buildIngestPayment(partida()).map((p) => p.source_tx_id)).toEqual([
      "ea-appt:42:efectivo",
      "ea-appt:42:transferencia",
    ]);
  });

  it("la cuenta de un solo método conserva la llave pelada", () => {
    // Uniformar sería más bonito y costaría el ingreso histórico completo.
    expect(buildIngestPayment(finance())[0].source_tx_id).toBe("ea-appt:42");
  });

  it("la propina va entera en el primer movimiento y en ninguno más", () => {
    // Prorratearla daría dos cifras que suman bien y que por separado no
    // significan nada; ponerla entera en cada uno la duplicaría.
    const pagos = buildIngestPayment(partida({ tip: 15_000 }));

    expect(pagos.map((p) => p.tip)).toEqual([15_000, 0]);
    expect(pagos.reduce((sum, p) => sum + p.tip, 0)).toBe(15_000);
  });

  it("los montos suman exactamente lo cobrado", () => {
    const pagos = buildIngestPayment(partida());
    expect(pagos.reduce((sum, p) => sum + p.amount, 0)).toBe(100_000);
  });

  it("no se empuja una cuenta cuyos pagos no cuadran", () => {
    // Es la última compuerta antes de que la cifra salga del panel, y lo que
    // sale de acá no vuelve: Actual no actualiza.
    expect(() =>
      buildIngestPayment(
        partida({
          payments: [
            { method: "efectivo", amount: 60_000 },
            { method: "transferencia", amount: 30_000 },
          ],
        }),
      ),
    ).toThrow(/no cuadra/);
  });

  it("el lote del día mezcla cuentas simples y partidas sin repetir llaves", () => {
    const pagos = buildDayClosePayments([
      finance({ eaAppointmentId: 1, amountCharged: 50_000, tip: 0 }),
      partida({ eaAppointmentId: 2, tip: 0 }),
      finance({ eaAppointmentId: 3, amountCharged: 80_000, tip: 0 }),
    ]);

    expect(pagos).toHaveLength(4);
    expect(new Set(pagos.map((p) => p.source_tx_id)).size).toBe(4);
  });

  it("el ajuste de una cuenta partida usa el método del pago más grande", () => {
    // Nadie registró por dónde entró la corrección: la pantalla pide monto y
    // motivo. Se elige el pago mayor porque es la apuesta más probable, es
    // determinista, y está en un solo lugar.
    expect(buildIngestAdjustment(partida(), -5_000, 1).method).toBe("efectivo");
  });

  it("y con el reparto al revés, el otro", () => {
    const ajuste = buildIngestAdjustment(
      partida({
        payments: [
          { method: "efectivo", amount: 20_000 },
          { method: "transferencia", amount: 80_000 },
        ],
      }),
      -5_000,
      1,
    );

    expect(ajuste.method).toBe("transferencia");
  });
});
