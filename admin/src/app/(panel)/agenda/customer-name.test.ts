import { describe, expect, it } from "vitest";

import { splitTermino } from "./customer-name";

/**
 * El reparto del término del buscador.
 *
 * Lo que se protege acá no es la partición en sí —es trivial— sino que el alta
 * rápida **nunca aparezca vacía** después de que alguien ya escribió el nombre.
 * Ese campo vacío es el momento exacto en que la clienta se apunta en un papel
 * y no entra nunca a la agenda.
 */
describe("splitTermino", () => {
  it("parte nombre y apellido en el primer espacio", () => {
    expect(splitTermino("Ana Ríos")).toEqual({
      nombre: "Ana",
      apellido: "Ríos",
      telefono: "",
    });
  });

  it("con tres palabras deja el resto como apellido", () => {
    // Imperfecto y consciente: "Ana María" podría ser el nombre. Los dos campos
    // quedan editables justo por esto.
    expect(splitTermino("Ana María Ríos")).toEqual({
      nombre: "Ana",
      apellido: "María Ríos",
      telefono: "",
    });
  });

  it("un solo nombre deja el apellido para que lo pregunten", () => {
    expect(splitTermino("Marcela")).toEqual({
      nombre: "Marcela",
      apellido: "",
      telefono: "",
    });
  });

  it("un número va al teléfono, no al nombre", () => {
    expect(splitTermino("300 123 4567")).toEqual({
      nombre: "",
      apellido: "",
      telefono: "300 123 4567",
    });
  });

  it("reconoce el número escrito como se escribe de verdad", () => {
    expect(splitTermino("+57 (300) 123-4567").telefono).toBe("+57 (300) 123-4567");
  });

  it("un término sin dígitos no es un teléfono aunque parezca puntuación", () => {
    // Sin la exigencia del dígito, `"---"` caía como teléfono y dejaba los dos
    // campos del nombre vacíos sin que nada lo explicara.
    expect(splitTermino("---")).toEqual({ nombre: "---", apellido: "", telefono: "" });
  });

  it("normaliza espacios de sobra en vez de arrastrarlos al campo", () => {
    expect(splitTermino("  Ana   Ríos  ")).toEqual({
      nombre: "Ana",
      apellido: "Ríos",
      telefono: "",
    });
  });

  it("un término vacío no inventa nada", () => {
    expect(splitTermino("   ")).toEqual({ nombre: "", apellido: "", telefono: "" });
  });
});
