import { describe, expect, it } from "vitest";

import { describeBlocker, describeBlockers } from "./blockers";

/**
 * Las frases de la compuerta.
 *
 * Se testean porque son la única explicación de por qué un botón está apagado.
 * Una frase que dice "1 días" o que suelta un `2026-09-04` en medio de una
 * oración no es un detalle de estilo: es el momento en que la dueña deja de
 * confiar en la pantalla y va a preguntar por WhatsApp.
 */

describe("describeBlocker", () => {
  it("escribe la fecha de fin de quincena en español", () => {
    expect(describeBlocker({ kind: "en-curso", until: "2026-09-15" })).toBe(
      "La quincena termina el martes 15 de septiembre y todavía está en curso.",
    );
  });

  it("nombra el día suelto sin cierre de caja", () => {
    expect(describeBlocker({ kind: "sin-cierre", days: ["2026-09-04"] })).toBe(
      "El viernes 4 de septiembre no tiene cierre de caja.",
    );
  });

  it("lista hasta tres días y cuenta el resto", () => {
    expect(
      describeBlocker({ kind: "sin-cierre", days: ["2026-09-01", "2026-09-02", "2026-09-03"] }),
    ).toBe(
      "3 días del periodo no tienen cierre de caja: martes 1 de septiembre, " +
        "miércoles 2 de septiembre, jueves 3 de septiembre.",
    );

    // Con quince días sin cerrar, nombrarlos todos es un párrafo que nadie lee.
    expect(
      describeBlocker({
        kind: "sin-cierre",
        days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"],
      }),
    ).toBe(
      "5 días del periodo no tienen cierre de caja: martes 1 de septiembre, " +
        "miércoles 2 de septiembre, jueves 3 de septiembre y 2 más.",
    );
  });

  it("distingue singular y plural en los renglones marcados", () => {
    expect(describeBlocker({ kind: "sin-regla", count: 1 })).toBe(
      "Un renglón quedó sin regla de comisión aplicable, con comisión en cero.",
    );
    expect(describeBlocker({ kind: "sin-regla", count: 4 })).toBe(
      "4 renglones quedaron sin regla de comisión aplicable, con comisión en cero.",
    );
  });
});

describe("describeBlockers", () => {
  it("conserva el orden en que la compuerta los devolvió", () => {
    expect(
      describeBlockers([
        { kind: "en-curso", until: "2026-09-15" },
        { kind: "sin-regla", count: 2 },
      ]),
    ).toEqual([
      "La quincena termina el martes 15 de septiembre y todavía está en curso.",
      "2 renglones quedaron sin regla de comisión aplicable, con comisión en cero.",
    ]);
  });

  it("sin bloqueos no dice nada", () => {
    expect(describeBlockers([])).toEqual([]);
  });
});
