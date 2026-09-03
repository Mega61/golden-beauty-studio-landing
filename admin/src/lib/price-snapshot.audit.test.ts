import { describe, expect, it } from "vitest";

import {
  resolveListPrice,
  resolvePriceSnapshot,
  type StoredPriceSnapshot,
} from "./price-snapshot";

import type { SnapshotSource } from "@/db/types";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 *
 * Lo único que separa "aviso en Diagnóstico" de "liquidación mal pagada en
 * silencio" es la marca. Se busca UN camino en el que un precio que no viene de
 * un congelado limpio salga sin ella.
 */

const SOURCES: SnapshotSource[] = ["webhook", "reconcile", "fallback"];
const PRECIOS = [null, 0, 1, -1, 95_000, 115_000, Number.MAX_SAFE_INTEGER];

describe("AUDIT · la marca no puede faltar por ningún camino", () => {
  it("producto cartesiano completo de stored × source × listPrice", () => {
    let cases = 0;

    for (const storedPrice of PRECIOS) {
      for (const source of SOURCES) {
        for (const listPrice of PRECIOS) {
          const stored: StoredPriceSnapshot | null =
            storedPrice === null && source === "webhook"
              ? null // el caso "no hay fila"
              : { price: storedPrice, source };

          const r = resolvePriceSnapshot({ stored, listPrice });

          expect(r.flagged).toBe(r.flag !== null);
          expect(Number.isSafeInteger(r.price)).toBe(true);

          const congeladoLimpio =
            stored !== null && stored.price !== null && stored.source !== "fallback";

          // Todo lo que NO sea un congelado limpio tiene que salir marcado.
          expect(r.flagged, JSON.stringify({ stored, listPrice, r })).toBe(!congeladoLimpio);

          // Y nunca se inventa un precio sin decirlo.
          if (r.price !== 0 && !congeladoLimpio) expect(r.flag).not.toBeNull();

          cases += 1;
        }
      }
    }

    expect(cases).toBeGreaterThan(100);
  });

  it("nunca lanza por falta de datos: la caja tiene que poder abrir la cuenta", () => {
    expect(() => resolvePriceSnapshot({ stored: null, listPrice: null })).not.toThrow();
    expect(() =>
      resolvePriceSnapshot({ stored: { price: null, source: "reconcile" }, listPrice: null }),
    ).not.toThrow();
  });

  it("un respaldo ya persistido sigue marcado después de guardarse", () => {
    // "Es la diferencia entre 'se resolvió' y 'se persistió'".
    const primera = resolvePriceSnapshot({ stored: null, listPrice: 115_000 });
    expect(primera).toEqual({
      price: 115_000,
      source: "fallback",
      flagged: true,
      flag: "sin-fila",
    });

    const segunda = resolvePriceSnapshot({
      stored: { price: primera.price, source: primera.source },
      listPrice: 115_000,
    });
    expect(segunda.flagged).toBe(true);
    expect(segunda.flag).toBe("respaldo-previo");
  });

  it("resolveListPrice marca todo id que el catálogo ya no tiene", () => {
    const catalogo = new Map([["acrylic-sculpted", 115_000]]);

    expect(resolveListPrice("acrylic-sculpted", catalogo)).toEqual({
      price: 115_000,
      flagged: false,
      flag: null,
    });

    for (const id of ["", " ", "ACRYLIC-SCULPTED", "acrylic_sculpted", "borrado", "__proto__"]) {
      const r = resolveListPrice(id, catalogo);
      expect(r.price, id).toBe(0);
      expect(r.flagged, id).toBe(true);
    }
  });

  it("los centavos revientan en vez de propagarse a un renglón", () => {
    expect(() =>
      resolvePriceSnapshot({ stored: { price: 115_000.5, source: "webhook" }, listPrice: null }),
    ).toThrow();
    expect(() => resolvePriceSnapshot({ stored: null, listPrice: 0.5 })).toThrow();
    expect(() => resolveListPrice("x", new Map([["x", 1.5]]))).toThrow();
  });

  it("observación: un congelado NEGATIVO pasa limpio y sin marca", () => {
    // No es un hallazgo con el contrato en la mano —el módulo solo promete
    // enteros de pesos— pero un `service_price_snapshot` negativo es un precio
    // que ninguna cita puede tener, y sale sin nada que lo señale.
    expect(resolvePriceSnapshot({ stored: { price: -115_000, source: "webhook" }, listPrice: 1 })).toEqual(
      { price: -115_000, source: "webhook", flagged: false, flag: null },
    );
  });
});
