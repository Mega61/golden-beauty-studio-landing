import { describe, expect, it } from "vitest";

import {
  IngestPayloadError,
  PAYMENT_METHODS,
  buildDayClosePayments,
  buildIngestAdjustment,
  buildIngestPayment,
  type FinanceForIngest,
} from "./ingest-payload";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 */

const finance = (over: Partial<FinanceForIngest> = {}): FinanceForIngest => ({
  eaAppointmentId: 501,
  amountCharged: 115_000,
  tip: 10_000,
  paymentMethod: "efectivo",
  paidOn: "2026-08-31",
  eaProviderId: 7,
  performedServiceId: 6,
  ...over,
});

describe("AUDIT · lo que sale del panel", () => {
  it("el método está siempre dentro del enum, y nada más pasa", () => {
    for (const method of PAYMENT_METHODS) {
      expect(buildIngestPayment(finance({ paymentMethod: method })).method).toBe(method);
    }

    for (const basura of ["Efectivo", "EFECTIVO", "tarjeta", "datafono", "", " efectivo", "otro "]) {
      expect(() =>
        buildIngestPayment(finance({ paymentMethod: basura as never })),
      ).toThrow(IngestPayloadError);
    }
  });

  it("la propina nunca entra al monto, para ninguna combinación", () => {
    for (const amount of [0, 1, 95_000, 115_000]) {
      for (const tip of [0, 5_000, 50_000]) {
        const p = buildIngestPayment(finance({ amountCharged: amount, tip }));
        expect(p.amount).toBe(amount);
        expect(p.tip).toBe(tip);
      }
    }
  });

  it("la fecha de caja tiene que ser YYYY-MM-DD y nada parecido", () => {
    for (const bad of [
      null,
      "",
      "2026-8-31",
      "31-08-2026",
      "2026/08/31",
      "2026-08-31 00:00:00",
      "2026-08-31T00:00:00Z",
      " 2026-08-31",
    ]) {
      expect(() => buildIngestPayment(finance({ paidOn: bad as never })), String(bad)).toThrow(
        IngestPayloadError,
      );
    }
  });

  it("el ajuste nunca reusa la llave del pago, para ninguna cita ni secuencia", () => {
    for (let ea = 1; ea <= 500; ea += 1) {
      const f = finance({ eaAppointmentId: ea });
      const pago = buildIngestPayment(f);
      const llaves = new Set([pago.imported_id]);

      for (let seq = 1; seq <= 6; seq += 1) {
        const ajuste = buildIngestAdjustment(f, -1_000 * seq, seq);
        expect(llaves.has(ajuste.imported_id)).toBe(false);
        llaves.add(ajuste.imported_id);
        // El ajuste comparte la fila Payment de Strapi, no el movimiento.
        expect(ajuste.source_tx_id).toBe(pago.source_tx_id);
      }
    }
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 7 (menor) — el lote del cierre diario no verifica que sus
 * `imported_id` sean únicos.
 *
 * `ingest-id.ts:180-183`: "**Dos cosas distintas con el mismo `imported_id`** ⇒
 * Actual se come la segunda en silencio y el ingreso del mes queda corto".
 * `buildDayClosePayments()` es la única función del panel que construye un
 * *conjunto* de esas llaves y es la única que no lo comprueba. Su propio
 * comentario dice que el lote se arma entero "antes de mandar nada" para que un
 * lote malo no salga a medias; un `ea_appointment_id` repetido es un lote malo y
 * sale entero.
 *
 * La UNIQUE de `appointment_finance.ea_appointment_id` lo hace inalcanzable
 * *desde la consulta del cierre*; la función recibe un arreglo, no una consulta.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · el lote del cierre diario", () => {
  it("no puede contener dos movimientos con el mismo imported_id", () => {
    // ARREGLADO lanzando, no devolviendo un lote limpio: un id repetido es un
    // error de programación aguas arriba, y devolver el lote deduplicado en
    // silencio lo escondería justo donde más caro sale. Es además el idioma que
    // esta función ya usaba para una cuenta mala — ver el test de abajo.
    expect(() =>
      buildDayClosePayments([
        finance({ eaAppointmentId: 501, amountCharged: 115_000 }),
        finance({ eaAppointmentId: 501, amountCharged: 95_000 }),
      ]),
    ).toThrow(IngestPayloadError);
  });

  it("una sola cuenta mala tumba el lote entero (esto sí se sostiene)", () => {
    expect(() =>
      buildDayClosePayments([finance(), finance({ paymentMethod: null }), finance()]),
    ).toThrow(IngestPayloadError);
  });
});
