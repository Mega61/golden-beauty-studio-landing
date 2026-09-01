import { afterEach, describe, expect, it } from "vitest";

import {
  addMinutes,
  compareEaLocal,
  EA_TIME_ZONE,
  EaDateTimeError,
  eaDatePart,
  eaLocalDateTime,
  eaLocalToInstant,
  eaTimePart,
  instantToEaDate,
  instantToEaLocal,
  isEaLocalDate,
  isEaLocalDateTime,
  minutesBetween,
  parseEaLocalDate,
  parseEaLocalDateTime,
} from "./datetime";

/**
 * La zona se fija **dentro del test**, no con un prefijo `TZ=… npm test`.
 *
 * En Git Bash sobre Windows `TZ=UTC comando` no llega al proceso: el prefijo lo
 * come el intérprete y el test correría en la zona de la máquina creyendo que
 * corre en UTC — verde y sin haber probado nada. Node sí relee `process.env.TZ`
 * en caliente (invalida su caché de zona), así que asignarla acá es la única
 * forma de que la invariante quede realmente verificada en las dos zonas.
 */
const originalTZ = process.env.TZ;

function setTZ(timeZone: string): void {
  process.env.TZ = timeZone;
}

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

/**
 * Las zonas del ensayo. `UTC` y `America/Bogota` porque son CI y la VM;
 * `Pacific/Kiritimati` (+14) y `Pacific/Niue` (−11) porque están a un día
 * entero de distancia entre sí y delatan cualquier cálculo que se apoye en la
 * zona del proceso — un desfase de horas podría pasar desapercibido, uno de un
 * día no.
 */
const ZONES = ["UTC", "America/Bogota", "Pacific/Kiritimati", "Pacific/Niue"] as const;

describe("la zona del proceso no puede cambiar ningún resultado", () => {
  it("el ensayo no es vacío: cambiar process.env.TZ sí mueve la zona efectiva", () => {
    setTZ("UTC");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");

    setTZ("Pacific/Kiritimati");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Pacific/Kiritimati");
  });

  it.each(ZONES)("eaLocalToInstant da el mismo instante con TZ=%s", (timeZone) => {
    setTZ(timeZone);

    // Bogotá es UTC−5 todo el año: las 14:00 del estudio son las 19:00 UTC.
    const instant = eaLocalToInstant(parseEaLocalDateTime("2026-08-31 14:00:00"));

    expect(instant.toISOString()).toBe("2026-08-31T19:00:00.000Z");
  });

  it.each(ZONES)("instantToEaLocal da la misma hora de pared con TZ=%s", (timeZone) => {
    setTZ(timeZone);

    expect(instantToEaLocal(new Date("2026-08-31T19:00:00.000Z"))).toBe("2026-08-31 14:00:00");
  });

  it.each(ZONES)("instantToEaDate resuelve el día del estudio con TZ=%s", (timeZone) => {
    setTZ(timeZone);

    // 01:00 UTC del 1 de septiembre todavía es 31 de agosto en el estudio. Es
    // exactamente el caso que rompe un cierre de caja calculado en UTC.
    expect(instantToEaDate(new Date("2026-09-01T01:00:00.000Z"))).toBe("2026-08-31");
    expect(instantToEaDate(new Date("2026-09-01T05:00:00.000Z"))).toBe("2026-09-01");
  });

  it.each(ZONES)("ida y vuelta es identidad con TZ=%s", (timeZone) => {
    setTZ(timeZone);

    const wall = parseEaLocalDateTime("2026-12-25 23:59:59");

    expect(instantToEaLocal(eaLocalToInstant(wall))).toBe(wall);
  });

  it.each(ZONES)("addMinutes cruza la medianoche igual con TZ=%s", (timeZone) => {
    setTZ(timeZone);

    expect(addMinutes(parseEaLocalDateTime("2026-08-31 23:30:00"), 45)).toBe("2026-09-01 00:15:00");
  });
});

describe("EA_TIME_ZONE", () => {
  it("es la zona del estudio", () => {
    expect(EA_TIME_ZONE).toBe("America/Bogota");
  });

  it("Colombia no tiene horario de verano: el offset es el mismo en enero y en julio", () => {
    const enero = eaLocalToInstant(parseEaLocalDateTime("2026-01-15 12:00:00"));
    const julio = eaLocalToInstant(parseEaLocalDateTime("2026-07-15 12:00:00"));

    expect(enero.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(julio.toISOString()).toBe("2026-07-15T17:00:00.000Z");
  });

  it("en una zona con horario de verano el offset sí cambia, y se respeta", () => {
    // No es un caso del estudio; prueba que el algoritmo de dos pasadas no está
    // asumiendo un offset fijo, que es de donde saldría el bug si mañana se
    // usara para formatear la hora de una clienta con `timezone` propio.
    const invierno = eaLocalToInstant(parseEaLocalDateTime("2026-01-15 12:00:00"), "Europe/Madrid");
    const verano = eaLocalToInstant(parseEaLocalDateTime("2026-07-15 12:00:00"), "Europe/Madrid");

    expect(invierno.toISOString()).toBe("2026-01-15T11:00:00.000Z");
    expect(verano.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });
});

describe("parseEaLocalDateTime", () => {
  it("acepta la forma que emite EA", () => {
    expect(parseEaLocalDateTime("2026-08-31 14:00:00")).toBe("2026-08-31 14:00:00");
  });

  it("normaliza el separador T al espacio que EA acepta de vuelta", () => {
    expect(parseEaLocalDateTime("2026-08-31T14:00:00")).toBe("2026-08-31 14:00:00");
  });

  it.each([
    ["sin segundos", "2026-08-31 14:00"],
    ["con zona", "2026-08-31T14:00:00Z"],
    ["con offset", "2026-08-31T14:00:00-05:00"],
    ["fecha imposible", "2026-02-30 10:00:00"],
    ["hora imposible", "2026-08-31 25:00:00"],
    ["ceros de MySQL", "0000-00-00 00:00:00"],
    ["vacío", ""],
  ])("rechaza %s", (_label, value) => {
    expect(() => parseEaLocalDateTime(value)).toThrow(EaDateTimeError);
  });

  it("rechaza lo que no es texto", () => {
    expect(() => parseEaLocalDateTime(1_756_000_000_000)).toThrow(EaDateTimeError);
    expect(() => parseEaLocalDateTime(null)).toThrow(EaDateTimeError);
  });

  it("un ISO con zona no pasa el type guard, que es el punto de la marca", () => {
    expect(isEaLocalDateTime("2026-08-31T14:00:00Z")).toBe(false);
    expect(isEaLocalDateTime("2026-08-31 14:00:00")).toBe(true);
  });
});

describe("fechas sueltas", () => {
  it("valida y rechaza", () => {
    expect(parseEaLocalDate("2026-08-31")).toBe("2026-08-31");
    expect(isEaLocalDate("2026-02-29")).toBe(false);
    expect(isEaLocalDate("2024-02-29")).toBe(true);
    expect(() => parseEaLocalDate("31/08/2026")).toThrow(EaDateTimeError);
  });

  it("parte fecha y parte hora", () => {
    const value = parseEaLocalDateTime("2026-08-31 14:05:09");

    expect(eaDatePart(value)).toBe("2026-08-31");
    expect(eaTimePart(value)).toBe("14:05:09");
  });
});

describe("eaLocalDateTime", () => {
  it("rellena con ceros", () => {
    expect(eaLocalDateTime(2026, 1, 2, 3, 4, 5)).toBe("2026-01-02 03:04:05");
  });

  it("por defecto es medianoche", () => {
    expect(eaLocalDateTime(2026, 8, 31)).toBe("2026-08-31 00:00:00");
  });

  it("rechaza componentes imposibles en vez de normalizarlos como Date", () => {
    expect(() => eaLocalDateTime(2026, 2, 30)).toThrow(EaDateTimeError);
    expect(() => eaLocalDateTime(2026, 13, 1)).toThrow(EaDateTimeError);
  });
});

describe("aritmética", () => {
  it("minutesBetween mide la duración de una cita", () => {
    expect(
      minutesBetween(
        parseEaLocalDateTime("2026-08-31 14:00:00"),
        parseEaLocalDateTime("2026-08-31 15:30:00"),
      ),
    ).toBe(90);
  });

  it("minutesBetween es negativo si el orden está invertido", () => {
    expect(
      minutesBetween(
        parseEaLocalDateTime("2026-08-31 15:30:00"),
        parseEaLocalDateTime("2026-08-31 14:00:00"),
      ),
    ).toBe(-90);
  });

  it("compareEaLocal ordena cronológicamente", () => {
    const a = parseEaLocalDateTime("2026-08-31 09:00:00");
    const b = parseEaLocalDateTime("2026-08-31 09:00:01");

    expect(compareEaLocal(a, b)).toBe(-1);
    expect(compareEaLocal(b, a)).toBe(1);
    expect(compareEaLocal(a, a)).toBe(0);
  });

  it("instantToEaLocal rechaza un Date inválido en vez de emitir NaN", () => {
    expect(() => instantToEaLocal(new Date("no es una fecha"))).toThrow(EaDateTimeError);
  });
});
