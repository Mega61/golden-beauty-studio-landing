import { describe, expect, it } from "vitest";

import { mapEaStatus } from "@/components/calendar/status-map";

import {
  STATUS_OPTIONS,
  parseStatusOptions,
  planStatusOptions,
  serializeStatusOptions,
} from "./status-options";

/** Lo que siembra la migración 043 de EA, tal cual. */
const EA_POR_DEFECTO = ["Booked", "Confirmed", "Rescheduled", "Cancelled", "Draft"];

describe("STATUS_OPTIONS", () => {
  it("trae los dos que EA no tiene y que el motor de comisiones necesita", () => {
    // Sin ellos no hay forma de distinguir una cita atendida de una que la
    // clienta no honró, y la quincena se liquidaría sobre las dos.
    expect(STATUS_OPTIONS).toContain("Completada");
    expect(STATUS_OPTIONS).toContain("No asistió");
  });

  it("el panel sabe traducir los seis", () => {
    // Es el contrato entre este job y `status-map.ts`: escribir en EA un estado
    // que el panel no traduce dejaría la agenda punteada entera, y el daño se
    // vería recién al abrir la pantalla.
    for (const option of STATUS_OPTIONS) {
      expect(mapEaStatus(option), option).not.toBe("desconocido");
    }
  });

  it("ninguno cae en el mismo token dos veces, salvo Reservada y Reprogramada", () => {
    // Reprogramada mapea a `reservada` a propósito (una cita movida sigue
    // esperando a la clienta). El resto tiene que ser distinto, o dos estados
    // distintos se pintarían igual y nadie podría distinguirlos en la agenda.
    const tokens = STATUS_OPTIONS.map(mapEaStatus);
    expect(new Set(tokens).size).toBe(STATUS_OPTIONS.length - 1);
  });
});

describe("parseStatusOptions", () => {
  it("lee el valor que siembra EA", () => {
    expect(parseStatusOptions(JSON.stringify(EA_POR_DEFECTO))).toEqual(EA_POR_DEFECTO);
  });

  it("devuelve null si el ajuste no existe", () => {
    expect(parseStatusOptions(null)).toBeNull();
  });

  it("devuelve null si no es JSON", () => {
    // EA lo lee con `json_decode` y lo trata como lista vacía, así que escribir
    // la lista buena encima es exactamente lo correcto.
    expect(parseStatusOptions("Booked, Confirmed")).toBeNull();
  });

  it("devuelve null si es JSON pero no una lista de cadenas", () => {
    expect(parseStatusOptions('{"a":1}')).toBeNull();
    expect(parseStatusOptions("[1, 2]")).toBeNull();
    expect(parseStatusOptions('["Booked", null]')).toBeNull();
  });
});

describe("planStatusOptions", () => {
  it("escribe sobre una agenda vacía con la lista por defecto de EA", () => {
    // El caso del corte: EA recién instalado, ninguna cita real todavía.
    expect(planStatusOptions({ current: EA_POR_DEFECTO, inUse: [] })).toEqual({
      action: "escribir",
      from: EA_POR_DEFECTO,
      to: STATUS_OPTIONS,
    });
  });

  it("escribe si el ajuste no existe", () => {
    expect(planStatusOptions({ current: null, inUse: [] })).toMatchObject({
      action: "escribir",
      from: null,
    });
  });

  it("no escribe si la lista ya es la correcta", () => {
    // Una escritura que no cambia nada igual deja rastro en el log de EA.
    expect(planStatusOptions({ current: [...STATUS_OPTIONS], inUse: [] })).toEqual({
      action: "ya-esta",
      options: STATUS_OPTIONS,
    });
  });

  it("escribe si la lista tiene los mismos pero en otro orden", () => {
    const revuelta = [...STATUS_OPTIONS].reverse();
    expect(planStatusOptions({ current: revuelta, inUse: [] })).toMatchObject({
      action: "escribir",
    });
  });

  it("no escribe si hay citas usando un estado que se perdería", () => {
    // Es la guarda entera: EA no migra el texto de las filas viejas, así que
    // esas citas quedarían con una cadena que el desplegable ya no ofrece.
    const plan = planStatusOptions({
      current: EA_POR_DEFECTO,
      inUse: ["Booked", "Confirmed"],
    });

    expect(plan.action).toBe("peligro");
    if (plan.action !== "peligro") throw new Error("debería haber sido peligro");
    expect(plan.losing).toEqual(["Booked", "Confirmed"]);
  });

  it("y los lista una sola vez, ordenados, aunque aparezcan en cien citas", () => {
    const plan = planStatusOptions({
      current: null,
      inUse: ["Pendiente", "Booked", "Pendiente", "Booked", "Pendiente"],
    });

    expect(plan).toMatchObject({ action: "peligro", losing: ["Booked", "Pendiente"] });
  });

  it("las citas sin estado no cuentan como estado en uso", () => {
    // El codec de A1 usa `""` cuando EA no manda el campo. Tratarlo como un
    // estado a preservar trabaría el job para siempre por una cita rota.
    expect(planStatusOptions({ current: null, inUse: ["", "   "] })).toMatchObject({
      action: "escribir",
    });
  });

  it("un estado ya en el vocabulario nuevo no bloquea, venga como venga escrito", () => {
    // `"no asistió"`, `"NO ASISTIO"` y `"No asistió"` son el mismo estado. Marcar
    // uno como perdido sería una falsa alarma, y una alarma falsa enseña a
    // ignorar la alarma.
    const plan = planStatusOptions({
      current: null,
      inUse: ["no asistió", "NO ASISTIO", "Completada", "completada"],
    });

    expect(plan.action).toBe("escribir");
  });

  it("acepta una lista destino distinta, para el día que el vocabulario cambie", () => {
    const plan = planStatusOptions({
      current: ["A"],
      inUse: ["A"],
      target: ["A", "B"],
    });

    expect(plan).toMatchObject({ action: "escribir", to: ["A", "B"] });
  });
});

describe("serializeStatusOptions", () => {
  it("escribe el mismo formato que la migración 043 de EA", () => {
    // Espacio después de la coma: no cambia nada funcional, y deja el valor
    // indistinguible de uno escrito por EA.
    expect(serializeStatusOptions(["Booked", "Confirmed"])).toBe('["Booked", "Confirmed"]');
  });

  it("escapa las tildes como JSON válido y vuelve a parsear igual", () => {
    const raw = serializeStatusOptions(STATUS_OPTIONS);
    expect(parseStatusOptions(raw)).toEqual([...STATUS_OPTIONS]);
  });

  it("aguanta una comilla en el nombre de un estado", () => {
    expect(parseStatusOptions(serializeStatusOptions(['Con "comillas"']))).toEqual([
      'Con "comillas"',
    ]);
  });
});
