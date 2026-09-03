import { describe, expect, it } from "vitest";

import { contrastRatio, CONTRAST_FLOOR } from "../ui/contrast";
import { NEUTRAL_TINT, parseHex, serviceTint, tintIsReadable } from "./service-color";

/** `--color-ink`, la tinta de cuerpo del panel. */
const INK = "#2a221c";

describe("parseHex", () => {
  it("acepta seis dígitos con y sin almohadilla", () => {
    expect(parseHex("#7cbae8")).toEqual([124, 186, 232]);
    expect(parseHex("7CBAE8")).toEqual([124, 186, 232]);
  });

  it("acepta la forma corta de tres", () => {
    expect(parseHex("#7ce")).toEqual([119, 204, 238]);
  });

  // EA guarda el color en un `varchar` de texto libre: llega de todo.
  it("todo lo que no es un hex es «no hay color»", () => {
    for (const raw of ["", "  ", "transparent", "rgb(1,2,3)", "#12345", "#gggggg", null, undefined]) {
      expect(parseHex(raw)).toBeNull();
    }
  });
});

describe("serviceTint", () => {
  it("sin color válido cae al neutro y lo dice", () => {
    expect(serviceTint(null)).toEqual(NEUTRAL_TINT);
    expect(serviceTint("azulito")).toEqual(NEUTRAL_TINT);
    expect(serviceTint(null).fromService).toBe(false);
  });

  it("con color válido conserva el tono y lo marca", () => {
    const tint = serviceTint("#7cbae8");
    expect(tint.fromService).toBe(true);
    // Mezclado hacia el papel: sigue siendo azulado, ya no saturado.
    const [r, g, b] = parseHex(tint.fill) as [number, number, number];
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });

  it("el filete lleva más color que el relleno", () => {
    const tint = serviceTint("#7cbae8");
    const fill = parseHex(tint.fill) as [number, number, number];
    const edge = parseHex(tint.edge) as [number, number, number];
    // Más lejos del papel en el canal que más se aleja: el rojo, acá.
    expect(Math.abs(edge[0] - 251)).toBeGreaterThan(Math.abs(fill[0] - 251));
  });

  // El punto entero del módulo: el color de EA no se pinta, se convierte en
  // algo sobre lo que se puede leer.
  it("la tinta de cuerpo llega a 4.5:1 sobre cualquier tinte", () => {
    const casos = [
      "#7cbae8", // el default de EA
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ac8231", // el dorado de marca
      "#1c1714", // el carbón
      "#7b2ff7",
      "#003300",
      null, // el neutro
    ];

    for (const hex of casos) {
      const tint = serviceTint(hex);
      const ratio = contrastRatio(INK, tint.fill);
      expect(ratio, `${hex ?? "neutro"} → ${tint.fill}`).toBeGreaterThanOrEqual(
        CONTRAST_FLOOR.bodyText,
      );
      expect(tintIsReadable(tint, INK)).toBe(true);
    }
  });

  it("dos servicios distintos no dan el mismo tinte", () => {
    expect(serviceTint("#7cbae8").fill).not.toBe(serviceTint("#e87c8b").fill);
  });

  it("es determinista", () => {
    expect(serviceTint("#7cbae8")).toEqual(serviceTint("7CBAE8"));
  });
});
