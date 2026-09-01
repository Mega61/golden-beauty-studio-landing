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

const finance = (over: Partial<FinanceForIngest> = {}): FinanceForIngest => ({
  eaAppointmentId: 42,
  amountCharged: 130_000,
  tip: 10_000,
  paymentMethod: "efectivo",
  paidOn: "2026-08-31",
  eaProviderId: 2,
  performedServiceId: 12,
  ...over,
});

describe("buildIngestPayment", () => {
  it("arma el pago de una cita cerrada", () => {
    expect(buildIngestPayment(finance())).toEqual({
      source: "ea",
      source_tx_id: "ea-appt:42",
      imported_id: "ea-tx:42",
      amount: 130_000,
      tip: 10_000,
      method: "efectivo",
      paid_on: "2026-08-31",
      ea_appointment_id: 42,
      ea_provider_id: 2,
      ea_service_id: 12,
    });
  });

  it("la propina viaja al lado del monto, nunca sumada", () => {
    // Meterla adentro inflaría el ingreso del mes con plata que es de la
    // técnica, y ese error no se ve hasta que alguien compara con la caja.
    const pago = buildIngestPayment(finance({ amountCharged: 100_000, tip: 50_000 }));

    expect(pago.amount).toBe(100_000);
    expect(pago.tip).toBe(50_000);
  });

  it("reporta el servicio REALIZADO, no el agendado", () => {
    // El encabezado guarda los dos; el que cruza hacia el CRM es el que se hizo.
    expect(buildIngestPayment(finance({ performedServiceId: 99 })).ea_service_id).toBe(99);
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
      expect(buildIngestPayment(finance({ paymentMethod: method })).method).toBe(method);
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
    expect(buildIngestPayment(finance({ amountCharged: 0, tip: 0 })).amount).toBe(0);
  });
});

describe("buildIngestAdjustment — corregir después del cierre", () => {
  it("el ajuste lleva id propio y el delta, no el total nuevo", () => {
    // Actual importa el ajuste como movimiento aparte y lo suma al que ya
    // tiene. Mandar el total nuevo duplicaría el ingreso de esa cita.
    expect(buildIngestAdjustment(finance(), -15_000, 1)).toEqual({
      source: "ea",
      source_tx_id: "ea-appt:42",
      imported_id: "ea-tx:42:adj1",
      amount: -15_000,
      tip: 0,
      method: "efectivo",
      paid_on: "2026-08-31",
      ea_appointment_id: 42,
      ea_provider_id: 2,
      ea_service_id: 12,
    });
  });

  it("el ajuste nunca reusa el imported_id del pago original", () => {
    // Reusarlo dejaría a Actual con la cifra vieja para siempre, sin error
    // visible: no actualiza montos de lo ya importado.
    const pago = buildIngestPayment(finance());
    const ajuste = buildIngestAdjustment(finance(), 5_000, 1);

    expect(ajuste.imported_id).not.toBe(pago.imported_id);
    expect(ajuste.source_tx_id).toBe(pago.source_tx_id);
  });

  it("dos ajustes de la misma cita son dos transacciones distintas", () => {
    expect(buildIngestAdjustment(finance(), 1_000, 1).imported_id).not.toBe(
      buildIngestAdjustment(finance(), 2_000, 2).imported_id,
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

    expect(pagos.map((p) => p.imported_id)).toEqual(["ea-tx:1", "ea-tx:2", "ea-tx:3"]);
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
