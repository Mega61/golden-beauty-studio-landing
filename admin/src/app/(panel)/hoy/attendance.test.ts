import { describe, expect, it } from "vitest";

import { marcarCompletadaAlCerrar } from "./attendance";

/**
 * Al cerrar la cuenta, la cita pasa a `Completada` — solo el estado, y sin
 * tumbar nunca el cierre.
 */
function fakeEa(fail = false) {
  const updates: { id: number; input: unknown }[] = [];
  return {
    updates,
    ea: {
      appointments: {
        update: async (id: number, input: unknown) => {
          updates.push({ id, input });
          if (fail) throw new Error("EA caído");
          return {};
        },
      },
    } as never,
  };
}

describe("marcarCompletadaAlCerrar", () => {
  it('escribe solo `{ status: "Completada" }`', async () => {
    const { ea, updates } = fakeEa();
    expect(await marcarCompletadaAlCerrar(ea, { id: 7, status: "Reservada" })).toBe("escrita");
    expect(updates).toEqual([{ id: 7, input: { status: "Completada" } }]);
  });

  it("no reescribe una cita que ya está Completada, ni toca una cancelada", async () => {
    const { ea, updates } = fakeEa();
    expect(await marcarCompletadaAlCerrar(ea, { id: 7, status: "Completada" })).toBe("sin-cambio");
    expect(await marcarCompletadaAlCerrar(ea, { id: 8, status: "Cancelada" })).toBe("sin-cambio");
    expect(updates).toEqual([]);
  });

  it("si EA falla no lanza: la cuenta ya está guardada y la noche lo reintenta", async () => {
    const { ea } = fakeEa(true);
    const original = console.error;
    console.error = () => {};
    try {
      await expect(marcarCompletadaAlCerrar(ea, { id: 7, status: "No asistió" })).resolves.toBe(
        "fallo",
      );
    } finally {
      console.error = original;
    }
  });
});
