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

  it("nombra la cita suelta sin cobrar y su día", () => {
    expect(describeBlocker({ kind: "sin-cobrar", days: ["2026-09-04"], count: 1 })).toBe(
      "Queda una cita atendida sin cobrar en el periodo: el viernes 4 de septiembre.",
    );
  });

  it("lista hasta tres días y cuenta el resto", () => {
    expect(
      describeBlocker({ kind: "sin-cobrar", days: ["2026-09-01", "2026-09-02", "2026-09-03"], count: 4 }),
    ).toBe(
      "Quedan 4 citas atendidas sin cobrar en el periodo: martes 1 de septiembre, " +
        "miércoles 2 de septiembre, jueves 3 de septiembre.",
    );

    expect(
      describeBlocker({
        kind: "sin-cobrar",
        days: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"],
        count: 5,
      }),
    ).toBe(
      "Quedan 5 citas atendidas sin cobrar en el periodo: martes 1 de septiembre, " +
        "miércoles 2 de septiembre, jueves 3 de septiembre y 2 días más.",
    );
  });

  it("sin agenda no afirma que esté todo cobrado", () => {
    expect(describeBlocker({ kind: "sin-agenda" })).toContain("No se pudo leer la agenda");
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
