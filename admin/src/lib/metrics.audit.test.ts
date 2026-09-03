import { describe, expect, it } from "vitest";

import {
  isEaLocalDateTime,
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDateTime,
} from "./ea/datetime";
import {
  computeOccupancy,
  retentionRate,
  splitCustomers,
  type Interval,
  type OccupancyAppointment,
  type VisitRecord,
} from "./metrics";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 *
 * Las definiciones de § Reportes se fijan "una vez y se usan igual en todos
 * lados". Se ataca la definición, no la aritmética.
 */

const at = (v: string) => parseEaLocalDateTime(v);
const day = (v: string) => parseEaLocalDate(v);
const span = (s: string, e: string): Interval => ({ start: at(s), end: at(e) });
const cita = (s: string, e: string, attended = true): OccupancyAppointment => ({
  ...span(s, e),
  attended,
});
const visita = (customerKey: string, when: string, attended = true): VisitRecord => ({
  customerKey,
  at: at(when),
  attended,
});

// ── Ocupación ───────────────────────────────────────────────────────────────

describe("AUDIT · ocupación", () => {
  const JORNADA = [span("2026-08-31 09:00:00", "2026-08-31 18:00:00")];

  it("la tasa nunca pasa de 1 ni baja de 0, sobre muchas combinaciones", () => {
    for (let start = 8; start <= 19; start += 1) {
      for (let dur = 0; dur <= 6; dur += 1) {
        const s = `2026-08-31 ${String(start).padStart(2, "0")}:00:00`;
        const e = `2026-08-31 ${String(start + dur).padStart(2, "0")}:00:00`;
        if (start + dur > 23) continue;

        const o = computeOccupancy({
          scheduled: JORNADA,
          blocked: [span("2026-08-31 13:00:00", "2026-08-31 14:00:00")],
          appointments: [cita(s, e)],
        });

        expect(o.rate).not.toBeNull();
        expect(o.rate!).toBeGreaterThanOrEqual(0);
        expect(o.rate!).toBeLessThanOrEqual(1);
        expect(o.busyMinutes).toBeLessThanOrEqual(o.availableMinutes);
        expect(o.overflowMinutes).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("null y no cero cuando no hay horas disponibles, por cualquier vía", () => {
    // Sin plan de trabajo.
    expect(computeOccupancy({ scheduled: [], blocked: [], appointments: [] }).rate).toBeNull();
    // Con el día entero bloqueado.
    expect(
      computeOccupancy({
        scheduled: JORNADA,
        blocked: JORNADA,
        appointments: [cita("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      }).rate,
    ).toBeNull();
    // Con un plan de duración cero.
    expect(
      computeOccupancy({
        scheduled: [span("2026-08-31 09:00:00", "2026-08-31 09:00:00")],
        blocked: [],
        appointments: [],
      }).rate,
    ).toBeNull();
  });

  it("una inasistencia nunca ocupa, cualquiera sea su tamaño y posición", () => {
    for (let start = 9; start < 18; start += 1) {
      const s = `2026-08-31 ${String(start).padStart(2, "0")}:00:00`;
      const e = `2026-08-31 ${String(start + 1).padStart(2, "0")}:00:00`;

      const o = computeOccupancy({
        scheduled: JORNADA,
        blocked: [],
        appointments: [cita(s, e, false)],
      });

      expect(o.busyMinutes).toBe(0);
      expect(o.availableMinutes).toBe(540);
      expect(o.overflowMinutes).toBe(0);
    }
  });

  it("da el mismo número con TZ=UTC y con TZ=America/Bogota", () => {
    const original = process.env.TZ;
    const resultados: string[] = [];

    for (const tz of ["UTC", "America/Bogota", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      resultados.push(
        JSON.stringify(
          computeOccupancy({
            scheduled: JORNADA,
            blocked: [span("2026-08-31 13:00:00", "2026-08-31 14:00:00")],
            appointments: [
              cita("2026-08-31 09:30:00", "2026-08-31 12:00:00"),
              cita("2026-08-31 17:00:00", "2026-08-31 19:00:00"),
            ],
          }),
        ),
      );
    }

    process.env.TZ = original;
    expect(new Set(resultados).size).toBe(1);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 5 — la retención se mueve sola, que es exactamente lo que el diseño
 * de `pending` dice que evita.
 *
 * `metrics.ts:305-312`: "Contarlas como 'no volvió' haría que la retención de un
 * mes recién cerrado se viera catastrófica y **mejorara sola** dos meses
 * después — un número que se mueve sin que nadie haga nada es un número en el
 * que nadie va a confiar."
 *
 * El filtro se aplica solo al denominador: quien **ya volvió** entra a
 * `returned` de inmediato, y quien todavía no volvió sale a `pending`. El
 * resultado es la enfermedad al revés: un periodo recién cerrado arranca cerca
 * del 100 % y **empeora solo** a medida que las ventanas se cumplen. Mismos
 * datos, mismo periodo, dos cifras distintas según cuándo se abra el reporte.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · la retención no puede cambiar sin que cambien los datos", () => {
  const PERIODO = { from: day("2026-01-01"), to: day("2026-01-31") };

  // Cuatro clientas atendidas el 15 de enero. Dos volvieron el 1 de febrero.
  // Las otras dos no volvieron nunca. El dataset está completo y congelado.
  const VISITAS: VisitRecord[] = [
    visita("+573001", "2026-01-15 10:00:00"),
    visita("+573002", "2026-01-15 11:00:00"),
    visita("+573003", "2026-01-15 12:00:00"),
    visita("+573004", "2026-01-15 13:00:00"),
    visita("+573001", "2026-02-01 10:00:00"),
    visita("+573002", "2026-02-01 11:00:00"),
  ];

  /**
   * ARREGLADO, con una salvedad sobre el arreglo.
   *
   * El hallazgo es correcto y grave: la cifra se movía sola. La corrección que
   * el hallazgo propone —medir siempre contra la cohorte completa, contando lo
   * pendiente como "no volvió"— **cambia una deriva por otra**: si una de las
   * pendientes vuelve el día 59, febrero diría 50 % y abril 75 %. Se movió
   * igual, solo que hacia arriba.
   *
   * La invariante que sí se sostiene es más fuerte: **mientras la ventana de
   * alguien siga abierta la tasa es `null`, y una vez que deja de serlo, no
   * vuelve a cambiar.** Una retención a 60 días no se puede conocer antes de
   * los 60 días, y decir "todavía no" es más honesto que publicar un número
   * que se va a corregir solo.
   */
  it("la tasa no cambia una vez que se puede calcular", () => {
    const alCumplirse = retentionRate(VISITAS, PERIODO, { now: at("2026-03-17 09:00:00") });
    const dosMesesDespues = retentionRate(VISITAS, PERIODO, { now: at("2026-04-30 09:00:00") });
    const unAñoDespués = retentionRate(VISITAS, PERIODO, { now: at("2027-04-30 09:00:00") });

    expect(alCumplirse.rate).toBe(0.5);
    expect(dosMesesDespues.rate).toBe(0.5);
    expect(unAñoDespués.rate).toBe(0.5);
  });

  it("mientras haya ventanas abiertas dice 'todavía no', no un número provisional", () => {
    const enFebrero = retentionRate(VISITAS, PERIODO, { now: at("2026-02-10 09:00:00") });

    // Las cuatro tienen la ventana abierta el 10 de febrero, así que ninguna es
    // medible todavía — incluidas las dos que ya volvieron, que sí se cuentan
    // en `returned` porque volver antes de tiempo es información real.
    expect(enFebrero).toEqual({ cohort: 4, returned: 2, pending: 4, rate: null });

    // Y con todas las ventanas cumplidas, el denominador es la cohorte entera.
    const enAbril = retentionRate(VISITAS, PERIODO, { now: at("2026-04-30 09:00:00") });
    expect(enAbril).toEqual({ cohort: 4, returned: 2, pending: 0, rate: 0.5 });
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * OBSERVACIÓN (no es hallazgo: no muerde hoy) — las dos métricas de clientas
 * ordenan comparando cadenas, y `EaLocalDateTime` admite dos formas.
 *
 * `isEaLocalDateTime()` —la guarda pública que estrecha al tipo del dominio—
 * acepta el separador `T` además del espacio (`ea/datetime.ts:59`, `[ T]`).
 * `computeOccupancy` es inmune porque pasa todo por `eaLocalToInstant()`;
 * `splitCustomers` y `retentionRate` comparan con `<` sobre la cadena.
 *
 * El separador vive en el índice 10, así que dos visitas de **días distintos**
 * se deciden antes de llegar a él y el orden sale bien. Solo se rompe entre
 * visitas del **mismo día**, y ahí ninguna de las dos métricas cambia de
 * resultado. Se deja fijado para que se vea el día que alguien agregue una
 * métrica intradía o guarde datetimes con `T` en la base.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · el orden de las visitas y el separador de la cadena", () => {
  const conT = (v: string): EaLocalDateTime => {
    if (!isEaLocalDateTime(v)) throw new Error(`la guarda del dominio rechazó ${v}`);
    return v;
  };

  it("entre días distintos el orden sale bien aunque se mezclen las dos formas", () => {
    const split = splitCustomers(
      [
        { customerKey: "+573001", at: conT("2025-11-20T10:00:00"), attended: true },
        visita("+573001", "2026-01-10 10:00:00"),
      ],
      { from: day("2026-01-01"), to: day("2026-01-31") },
    );

    expect(split.returningCustomers).toEqual(["+573001"]);
    expect(split.newCustomers).toEqual([]);
  });

  it("dentro del MISMO día el separador manda sobre la hora", () => {
    // Las 09:00 con `T` ordenan después de las 18:00 con espacio.
    expect(conT("2026-01-15T09:00:00") > at("2026-01-15 18:00:00")).toBe(true);

    // `retentionRate` toma la "última visita del periodo" con ese mismo `>`, así
    // que elegiría las 09:00. Hoy no cambia ninguna cifra —la ventana es de 60
    // días y las dos visitas son del mismo día— pero la suposición no está
    // guardada en ningún lado.
    const r = retentionRate(
      [
        { customerKey: "+573001", at: conT("2026-01-15T09:00:00"), attended: true },
        visita("+573001", "2026-01-15 18:00:00"),
        visita("+573001", "2026-02-20 10:00:00"),
      ],
      { from: day("2026-01-01"), to: day("2026-01-31") },
      { now: at("2026-06-01 00:00:00") },
    );

    expect(r).toEqual({ cohort: 1, returned: 1, pending: 0, rate: 1 });
  });
});
