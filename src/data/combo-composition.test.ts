import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pricing } from "./pricing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * La composición de los combos: la que declara la vitrina, y la copia horneada
 * que viaja dentro de la imagen del panel.
 *
 * ## Por qué hay una copia
 *
 * `composedOf` dice de qué dos servicios se compone cada combo, y es lo que
 * permite que la agenda y el flujo público de reserva lleguen a un combo
 * eligiendo sus mitades en vez de buscándolo en una lista. El panel necesita ese
 * dato, y el panel **no contiene la landing**: su imagen se construye con
 * contexto `admin/`. Leer este archivo en caliente obligaba a montarlo en el
 * contenedor, o sea que la función solo existía si alguien se acordaba.
 *
 * Así que `scripts/build-combo-map.mjs` lo copia a
 * `admin/src/data/combo-composition.ts`, que se commitea.
 *
 * ## Por qué esto se testea acá y no allá
 *
 * Porque el archivo generado **no se puede validar contra su fuente desde
 * `admin/`**: allá la fuente no existe. Este es el único lado donde están los
 * dos, y un archivo generado que quedó viejo es peor que no tenerlo — parece al
 * día. Es la misma razón por la que `check-pricing.mjs` corre en el `prebuild`.
 */
describe("composedOf en la vitrina", () => {
  const combos = pricing.find((cat) => cat.id === "combos")?.items ?? [];
  const standalone = new Set(
    pricing.filter((cat) => cat.id !== "combos").flatMap((cat) => cat.items.map((it) => it.id)),
  );

  it("hay combos, y todos declaran de qué se componen", () => {
    // Un combo sin `composedOf` es inalcanzable: ninguna pantalla lo lista.
    expect(combos.length).toBeGreaterThan(0);
    for (const item of combos) {
      expect(item.composedOf, item.id).toBeDefined();
    }
  });

  it("las dos mitades son servicios sueltos que existen", () => {
    for (const item of combos) {
      expect(standalone.has(item.composedOf!.hands), `${item.id}.hands`).toBe(true);
      expect(standalone.has(item.composedOf!.feet), `${item.id}.feet`).toBe(true);
    }
  });

  it("un combo cuesta menos que sus dos mitades, que es el punto del combo", () => {
    const priceOf = new Map(
      pricing.flatMap((cat) => cat.items.map((it) => [it.id, it.priceCOP] as const)),
    );

    for (const item of combos) {
      const suma =
        priceOf.get(item.composedOf!.hands)! + priceOf.get(item.composedOf!.feet)!;
      expect(item.priceCOP, `${item.id} debería costar menos que ${suma}`).toBeLessThan(suma);
    }
  });

  it("nada fuera de la categoría `combos` declara composición", () => {
    for (const cat of pricing) {
      if (cat.id === "combos") continue;
      for (const item of cat.items) {
        expect(item.composedOf, `${cat.id}.${item.id}`).toBeUndefined();
      }
    }
  });
});

describe("la copia horneada en admin/", () => {
  it("está al día con src/data/pricing.ts", () => {
    // `--check` no escribe: compara y falla. Si esto se pone rojo, el arreglo es
    // `npm run build-combo-map` y commitear el resultado.
    //
    // Se invoca el script de verdad en vez de reimplementar la comparación:
    // duplicar el generador en el test dejaría al test pasando sobre la misma
    // suposición equivocada que el generador.
    expect(() =>
      execFileSync("node", ["scripts/build-combo-map.mjs", "--check"], {
        cwd: ROOT,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
