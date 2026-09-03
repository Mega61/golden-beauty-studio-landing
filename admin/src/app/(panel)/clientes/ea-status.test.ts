import { describe, expect, it } from "vitest";

import { eaStatusToken, freedTheChair, isCompletedStatus } from "./ea-status";

describe("eaStatusToken", () => {
  it("traduce los cinco que siembra la migración 043 de EA", () => {
    expect(eaStatusToken("Booked")).toBe("reservada");
    expect(eaStatusToken("Confirmed")).toBe("confirmada");
    expect(eaStatusToken("Cancelled")).toBe("cancelada");
    // Los dos que EA no trae y el motor de comisiones necesita: sin inventar.
    expect(eaStatusToken("Rescheduled")).toBe("desconocido");
    expect(eaStatusToken("Draft")).toBe("desconocido");
  });

  it("acepta la lista en español que el estudio configura", () => {
    expect(eaStatusToken("Reservada")).toBe("reservada");
    expect(eaStatusToken("Confirmada")).toBe("confirmada");
    expect(eaStatusToken("Completada")).toBe("completada");
    expect(eaStatusToken("Cancelada")).toBe("cancelada");
    expect(eaStatusToken("No asistió")).toBe("no-asistio");
  });

  it("las dos listas conviven, porque renombrar en EA no migra las filas viejas", () => {
    expect(eaStatusToken("Booked")).toBe(eaStatusToken("Reservada"));
  });

  it("no le importan tildes, mayúsculas ni separadores", () => {
    for (const forma of ["NO ASISTIO", "no_asistio", "  No Asistió  ", "no-asistio"]) {
      expect(eaStatusToken(forma), forma).toBe("no-asistio");
    }
  });

  it("cualquier cosa que no reconoce sale punteada, no inventada", () => {
    for (const raro of ["", "   ", "Pendiente de pago", "xyz", null, undefined]) {
      expect(eaStatusToken(raro), String(raro)).toBe("desconocido");
    }
  });
});

describe("las dos preguntas que hace el resto del panel", () => {
  it("solo 'completada' habilita la cuenta", () => {
    expect(isCompletedStatus("Completada")).toBe(true);
    expect(isCompletedStatus("Completed")).toBe(true);
    expect(isCompletedStatus("Confirmada")).toBe(false);
    expect(isCompletedStatus(null)).toBe(false);
  });

  it("una inasistencia NO libera la silla, aunque haya quedado vacía", () => {
    expect(freedTheChair("Cancelada")).toBe(true);
    expect(freedTheChair("No asistió")).toBe(false);
    expect(freedTheChair("Reservada")).toBe(false);
  });
});
