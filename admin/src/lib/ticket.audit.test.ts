import { describe, expect, it } from "vitest";

import {
  TicketError,
  assertTicketInvariant,
  computeTicketTotals,
  ticketFromEnteredTotal,
  validateTicketClose,
  type TicketItemInput,
} from "./ticket";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 */

const servicio = (unitPriceSnapshot: number, qty = 1): TicketItemInput => ({
  kind: "servicio",
  eaServiceId: 6,
  pricingId: "acrylic-sculpted",
  qty,
  unitPriceSnapshot,
});

const adicional = (unitPriceSnapshot: number, qty = 1): TicketItemInput => ({
  kind: "adicional",
  eaServiceId: null,
  pricingId: "design-per-nail",
  qty,
  unitPriceSnapshot,
});

// ── La invariante, en grande ────────────────────────────────────────────────

describe("AUDIT · Σ line_total − discount === amount_charged, sobre miles de cuentas", () => {
  it("con renglones positivos, en cero y negativos mezclados", () => {
    const precios = [-40_000, -1, 0, 1, 7, 10_000, 33_333, 115_000];
    let cases = 0;

    for (const a of precios) {
      for (const b of precios) {
        for (const qty of [1, 2, 3, 7]) {
          const items = [servicio(a), adicional(b, qty)];
          const subtotal = a + b * qty;

          for (const discount of [0, 1, 3, 999, Math.max(subtotal, 0)]) {
            if (discount > subtotal) continue;

            const totals = computeTicketTotals(items, discount, 12_000);

            expect(() => assertTicketInvariant(totals)).not.toThrow();
            expect(totals.amountCharged).toBe(subtotal - discount);
            expect(totals.lines.reduce((s, l) => s + l.discountShare, 0)).toBe(discount);
            expect(totals.lines.reduce((s, l) => s + l.netTotal, 0)).toBe(totals.amountCharged);
            // La propina jamás entra a la base de comisión.
            expect(totals.amountPaid - totals.amountCharged).toBe(12_000);
            cases += 1;
          }
        }
      }
    }

    expect(cases).toBeGreaterThan(500);
  });

  it("ningún renglón positivo recibe más descuento del que vale", () => {
    for (let discount = 0; discount <= 145_000; discount += 137) {
      const items = [servicio(115_000), adicional(10_000, 3)];
      const totals = computeTicketTotals(items, discount);

      for (const l of totals.lines) {
        expect(l.discountShare).toBeGreaterThanOrEqual(0);
        expect(l.discountShare).toBeLessThanOrEqual(l.lineTotal);
      }
    }
  });
});

describe("AUDIT · el signo vive en el precio unitario", () => {
  it("no hay forma de colar un crédito por la cantidad", () => {
    for (const qty of [-3, -1, 0]) {
      expect(() => computeTicketTotals([servicio(10_000, qty)])).toThrow(TicketError);
    }
    // Y el caso que el contrato nombra: qty −2 × precio −1000 = +2000.
    expect(() => computeTicketTotals([servicio(-1_000, -2)])).toThrow(TicketError);
  });

  it("tampoco por un total ingresado negativo", () => {
    expect(() => ticketFromEnteredTotal([servicio(115_000)], -50_000)).toThrow(TicketError);
  });

  it("una cuenta que es toda créditos no acepta descuento encima", () => {
    // Prorratear sobre renglones positivos cuando no hay ninguno no puede
    // devolver ceros en silencio.
    expect(() => computeTicketTotals([servicio(-50_000)], 1)).toThrow(TicketError);
    expect(() => computeTicketTotals([servicio(0), adicional(0)], 1)).toThrow(TicketError);
  });

  it("y una cuenta toda créditos no se puede construir NI con descuento cero", () => {
    // Descubierto acá: la guarda es `discount > subtotal`, así que un subtotal
    // negativo la dispara con `discount = 0`. El efecto es correcto —una
    // devolución neta no existe en la v1— pero el mensaje que llega a la
    // pantalla de la técnica dice "El descuento (0) es mayor que el subtotal
    // (-50000)", que no describe lo que pasó.
    expect(() => computeTicketTotals([servicio(-50_000)])).toThrow(
      /El descuento \(0\) es mayor que el subtotal/,
    );
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 4 — el total editado a mano no pide el motivo.
 *
 * § Independencia con rastro: "**Si el total difiere del calculado, se pide un
 * motivo.** Un `reason_code` de lista corta más texto libre. **Sin motivo no se
 * guarda**". § El flujo, paso 3: "Total — grande, calculado […] Tocarlo lo hace
 * editable **y abre el motivo**".
 *
 * `validateTicketClose()` sí impone la regla, pero recibe `discount`.
 * `ticketFromEnteredTotal()` —la función que existe justamente para el caso
 * "la técnica tocó el total"— deriva el descuento y devuelve la cuenta sin
 * pasar por esa compuerta y sin poder recibir un motivo. Las dos funciones no
 * están compuestas, así que el camino que el plan describe como *el* que abre el
 * motivo es exactamente el que no lo exige.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · sin motivo no se guarda", () => {
  it("bajar el total escribiéndolo no se puede guardar sin motivo", () => {
    expect(() => ticketFromEnteredTotal([servicio(115_000)], 95_000)).toThrow(TicketError);
  });

  it("bajar el total con un renglón negativo tampoco", () => {
    // El otro camino con el mismo efecto: el cobro queda 30.000 por debajo del
    // precio de lista y `discount` es 0, así que la compuerta no se activa.
    expect(() =>
      validateTicketClose({ items: [servicio(115_000), adicional(-30_000)] }),
    ).toThrow(TicketError);
  });

  it("el camino que sí está cubierto: descuento explícito sin motivo", () => {
    expect(() =>
      validateTicketClose({ items: [servicio(115_000)], discount: 20_000 }),
    ).toThrow(TicketError);
  });
});
