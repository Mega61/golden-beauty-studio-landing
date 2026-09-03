import { describe, expect, it } from "vitest";

import type { DayGridRange } from "@/lib/calendar-layout";
import { parseEaLocalDate } from "@/lib/ea/datetime";
import {
  columnHeight,
  dragDeltaMinutes,
  laneBox,
  minuteToPx,
  pointerMinute,
  pxToMinute,
  snapMinute,
  spanBox,
} from "./geometry";

/** La jornada del estudio: 8:00 a 20:00 en filas de 15 minutos. */
const RANGE: DayGridRange = {
  date: parseEaLocalDate("2026-08-31"),
  startMinute: 8 * 60,
  endMinute: 20 * 60,
  slotMinutes: 15,
};

const SLOT_H = 14;

describe("minuteToPx / pxToMinute", () => {
  it("el inicio de la jornada está en el píxel cero", () => {
    expect(minuteToPx(480, RANGE, SLOT_H)).toBe(0);
  });

  it("una hora son cuatro filas", () => {
    expect(minuteToPx(540, RANGE, SLOT_H)).toBe(4 * SLOT_H);
  });

  it("un minuto anterior al rango da negativo en vez de recortarse", () => {
    expect(minuteToPx(465, RANGE, SLOT_H)).toBe(-SLOT_H);
  });

  it("es el inverso exacto de pxToMinute", () => {
    for (const minute of [480, 495, 733, 1199]) {
      expect(pxToMinute(minuteToPx(minute, RANGE, SLOT_H), RANGE, SLOT_H)).toBeCloseTo(minute, 9);
    }
  });
});

describe("columnHeight", () => {
  it("usa el rowCount del motor, no una división propia", () => {
    // 12 horas / 15 min = 48 filas.
    expect(columnHeight(48, SLOT_H)).toBe(672);
  });
});

describe("spanBox", () => {
  it("posiciona y mide un tramo normal", () => {
    expect(spanBox(600, 690, RANGE, SLOT_H)).toEqual({ top: 8 * SLOT_H, height: 6 * SLOT_H });
  });

  // Un bloque de alto cero no se puede tocar ni leer: equivale a haberlo
  // perdido. Las citas ya vienen con `renderHeightMinutes`; las bandas no.
  it("nunca deja un alto de cero", () => {
    expect(spanBox(600, 600, RANGE, SLOT_H).height).toBe(1);
  });
});

describe("laneBox", () => {
  it("un bloque solo ocupa la columna entera, sin canaleta", () => {
    expect(laneBox(0, 1)).toEqual({ leftPercent: 0, widthPercent: 100 });
  });

  it("dos encimados se reparten la mitad menos la canaleta", () => {
    expect(laneBox(0, 0.5)).toEqual({ leftPercent: 0, widthPercent: 48.5 });
    expect(laneBox(0.5, 0.5)).toEqual({ leftPercent: 50, widthPercent: 48.5 });
  });

  // La canaleta se resta del ancho y nunca del `left`: el borde izquierdo de
  // cada carril tiene que caer donde el motor dijo.
  it("el borde izquierdo respeta el offset del motor", () => {
    expect(laneBox(2 / 3, 1 / 3).leftPercent).toBeCloseTo(66.667, 3);
  });

  it("con muchos carriles el ancho no cae por debajo de 1 %", () => {
    expect(laneBox(0, 0.01).widthPercent).toBe(1);
  });
});

describe("snapMinute", () => {
  it("ajusta al slot más cercano, no hacia abajo", () => {
    expect(snapMinute(487, RANGE)).toBe(480 + 0); // 7 min → misma fila
    expect(snapMinute(489, RANGE)).toBe(495); // 9 min → la de abajo
  });

  it("no deja empezar antes de la jornada", () => {
    expect(snapMinute(0, RANGE)).toBe(480);
  });

  // Soltar en el último píxel tiene que dar el último hueco utilizable, no una
  // cita que empieza cuando el estudio ya cerró.
  it("el tope es el último hueco, no el fin de la jornada", () => {
    expect(snapMinute(1200, RANGE)).toBe(1185);
    expect(snapMinute(99999, RANGE)).toBe(1185);
  });

  it("un rango de un solo slot colapsa en su inicio", () => {
    const tiny: DayGridRange = { ...RANGE, startMinute: 600, endMinute: 615 };
    expect(snapMinute(9999, tiny)).toBe(600);
  });
});

describe("pointerMinute", () => {
  it("traduce un toque en la columna a un hueco de la rejilla", () => {
    // 8 filas y media desde arriba: 8:00 + 2 h 7 min → se ajusta a las 10:00.
    expect(pointerMinute(8.4 * SLOT_H, RANGE, SLOT_H)).toBe(600);
  });

  it("un toque arriba del borde no crea una cita antes de abrir", () => {
    expect(pointerMinute(-40, RANGE, SLOT_H)).toBe(480);
  });
});

describe("dragDeltaMinutes", () => {
  it("mueve por múltiplos del slot, con signo", () => {
    expect(dragDeltaMinutes(4 * SLOT_H, RANGE, SLOT_H)).toBe(60);
    expect(dragDeltaMinutes(-2 * SLOT_H, RANGE, SLOT_H)).toBe(-30);
  });

  it("un temblor de pocos píxeles no mueve nada", () => {
    expect(dragDeltaMinutes(3, RANGE, SLOT_H)).toBe(0);
  });
});
