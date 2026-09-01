import { describe, expect, it } from "vitest";

import {
  PriceSnapshotError,
  resolveListPrice,
  resolvePriceSnapshot,
  type PriceSnapshotInput,
} from "./price-snapshot";

import type { SnapshotSource } from "@/db/types";

/**
 * El test que importa acá no es "devuelve el precio correcto" — eso es una
 * línea. Es **"la marca nunca puede faltar"**, y por eso el bloque principal
 * recorre el producto cartesiano completo de entradas en vez de tres ejemplos.
 *
 * La razón está en el módulo: un precio de hoy sobre una cita vieja es
 * indistinguible de un precio congelado. La marca es lo único que separa un
 * aviso en Diagnóstico de una liquidación mal pagada en silencio.
 */

const SOURCES: SnapshotSource[] = ["webhook", "reconcile", "fallback"];

describe("resolvePriceSnapshot — la marca no puede faltar", () => {
  it("todo precio que no venga de un congelado limpio sale marcado", () => {
    const stored: PriceSnapshotInput["stored"][] = [
      null,
      ...SOURCES.map((source) => ({ price: null, source })),
      ...SOURCES.map((source) => ({ price: 115_000, source })),
    ];
    const listPrices: (number | null)[] = [null, 0, 1, 115_000, 999_999];

    for (const s of stored) {
      for (const listPrice of listPrices) {
        const result = resolvePriceSnapshot({ stored: s, listPrice });

        // La invariante estructural: `flagged` es siempre `flag !== null`.
        expect(result.flagged).toBe(result.flag !== null);

        const fromClearSnapshot = s !== null && s.price !== null && s.source !== "fallback";

        // Y la de negocio: solo un congelado limpio sale sin marca.
        expect(result.flagged).toBe(!fromClearSnapshot);
        expect(Number.isSafeInteger(result.price)).toBe(true);
      }
    }
  });
});

describe("resolvePriceSnapshot — cada caso, con su marca", () => {
  it("hay congelado: manda el congelado, sin marca", () => {
    const result = resolvePriceSnapshot({
      stored: { price: 115_000, source: "webhook" },
      listPrice: 130_000,
    });

    // El precio de hoy es otro y no importa: la cita se agendó con el de antes.
    expect(result).toEqual({ price: 115_000, source: "webhook", flagged: false, flag: null });
  });

  it("el congelado del reconcile también es limpio", () => {
    // El reconcile es el mecanismo principal, no el respaldo: lo que trae vale
    // tanto como lo que trajo el webhook.
    const result = resolvePriceSnapshot({
      stored: { price: 90_000, source: "reconcile" },
      listPrice: 95_000,
    });

    expect(result.flagged).toBe(false);
    expect(result.source).toBe("reconcile");
  });

  it("un congelado que ya era respaldo sigue marcado después de guardarse", () => {
    // Es la diferencia entre "se resolvió" y "se persistió": la cita se sigue
    // valorando con un precio que no regía cuando se agendó, y eso no deja de
    // ser cierto porque alguien lo haya escrito en la base.
    const result = resolvePriceSnapshot({
      stored: { price: 95_000, source: "fallback" },
      listPrice: 95_000,
    });

    expect(result).toEqual({
      price: 95_000,
      source: "fallback",
      flagged: true,
      flag: "respaldo-previo",
    });
  });

  it("no hay fila: cae al precio de lista y marca sin-fila", () => {
    // El webhook se perdió — EA no reintenta, así que es el modo de falla
    // esperado, no el raro.
    expect(resolvePriceSnapshot({ stored: null, listPrice: 115_000 })).toEqual({
      price: 115_000,
      source: "fallback",
      flagged: true,
      flag: "sin-fila",
    });
  });

  it("hay fila sin congelado: cae al precio de lista y marca sin-snapshot", () => {
    expect(
      resolvePriceSnapshot({ stored: { price: null, source: "webhook" }, listPrice: 80_000 }),
    ).toEqual({ price: 80_000, source: "fallback", flagged: true, flag: "sin-snapshot" });
  });

  it("ni congelado ni lista: cero con la marca más ruidosa", () => {
    // Éste es el que bloquea el cierre del día. Un cero acá sin marca sería
    // indistinguible de una cortesía.
    for (const stored of [null, { price: null, source: "reconcile" as SnapshotSource }]) {
      expect(resolvePriceSnapshot({ stored, listPrice: null })).toEqual({
        price: 0,
        source: "fallback",
        flagged: true,
        flag: "sin-precio-de-lista",
      });
    }
  });

  it("un precio de lista de cero es un precio, no una ausencia", () => {
    expect(resolvePriceSnapshot({ stored: null, listPrice: 0 })).toEqual({
      price: 0,
      source: "fallback",
      flagged: true,
      flag: "sin-fila",
    });
  });

  it("nunca lanza por falta de datos", () => {
    // Devolver un error dejaría la caja sin poder abrir la cuenta, y el
    // problema es del precio, no de la cita.
    expect(() => resolvePriceSnapshot({ stored: null, listPrice: null })).not.toThrow();
  });

  it("sí lanza con centavos, que son un bug de conversión aguas arriba", () => {
    expect(() => resolvePriceSnapshot({ stored: null, listPrice: 1_000.5 })).toThrow(
      PriceSnapshotError,
    );

    expect(() =>
      resolvePriceSnapshot({ stored: { price: 1_000.5, source: "webhook" }, listPrice: null }),
    ).toThrow(/congelado/);
  });
});

describe("resolveListPrice — el precio de un adicional", () => {
  const catalogo = new Map([
    ["design-per-nail", 10_000],
    ["system-removal", 20_000],
  ]);

  it("un id del catálogo sale sin marca", () => {
    expect(resolveListPrice("design-per-nail", catalogo)).toEqual({
      price: 10_000,
      flagged: false,
      flag: null,
    });
  });

  it("un id que ya no existe sale en cero y marcado", () => {
    // El caso real: el servicio se renombró entre que se armó el borrador en el
    // celular y se envió.
    expect(resolveListPrice("servicio-que-ya-no-existe", catalogo)).toEqual({
      price: 0,
      flagged: true,
      flag: "sin-precio-de-lista",
    });
  });

  it("un catálogo con centavos revienta en vez de propagarlos", () => {
    expect(() => resolveListPrice("roto", new Map([["roto", 10.5]]))).toThrow(/precio de lista/);
  });
});
