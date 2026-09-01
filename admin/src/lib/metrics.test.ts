import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "./ea/datetime";
import {
  MetricsError,
  chairHourRanking,
  computeOccupancy,
  isNewCustomer,
  retentionRate,
  revenuePerChairHour,
  splitCustomers,
  type Interval,
  type OccupancyAppointment,
  type VisitRecord,
} from "./metrics";

const at = (value: string) => parseEaLocalDateTime(value);
const day = (value: string) => parseEaLocalDate(value);

const span = (start: string, end: string): Interval => ({ start: at(start), end: at(end) });

const cita = (start: string, end: string, attended = true): OccupancyAppointment => ({
  ...span(start, end),
  attended,
});

/** Una jornada de 9 a 18, que es la forma del plan de trabajo del estudio. */
const JORNADA = [span("2026-08-31 09:00:00", "2026-08-31 18:00:00")];

describe("ocupación", () => {
  it("minutos atendidos ÷ minutos disponibles", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [cita("2026-08-31 09:00:00", "2026-08-31 12:00:00")],
    });

    expect(occupancy.availableMinutes).toBe(540);
    expect(occupancy.busyMinutes).toBe(180);
    expect(occupancy.rate).toBeCloseTo(1 / 3, 10);
  });

  it("una INASISTENCIA no cuenta como ocupada", () => {
    // Es la definición del plan, y es la mitad del valor del reporte: si una
    // inasistencia contara, el tablero de ocupación nunca mostraría el problema
    // que los recordatorios de WhatsApp existen para resolver.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [
        cita("2026-08-31 09:00:00", "2026-08-31 12:00:00", true),
        cita("2026-08-31 12:00:00", "2026-08-31 15:00:00", false),
      ],
    });

    expect(occupancy.busyMinutes).toBe(180);
    expect(occupancy.availableMinutes).toBe(540);
  });

  it("una inasistencia tampoco reduce el denominador", () => {
    // La silla estuvo libre. Restarla del denominador escondería la hora
    // perdida, que es justo lo que hay que ver.
    const conInasistencia = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [cita("2026-08-31 12:00:00", "2026-08-31 15:00:00", false)],
    });

    expect(conInasistencia.availableMinutes).toBe(540);
    expect(conInasistencia.rate).toBe(0);
  });

  it("un BLOQUEO reduce el denominador", () => {
    // Una tarde que el estudio cerró no es una tarde que se desaprovechó.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [span("2026-08-31 13:00:00", "2026-08-31 18:00:00")],
      appointments: [cita("2026-08-31 09:00:00", "2026-08-31 12:00:00")],
    });

    expect(occupancy.availableMinutes).toBe(240);
    expect(occupancy.busyMinutes).toBe(180);
    expect(occupancy.rate).toBe(0.75);
  });

  it("un bloqueo que tapa media cita: cuentan los minutos que quedan", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [span("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      appointments: [cita("2026-08-31 09:30:00", "2026-08-31 11:30:00")],
    });

    expect(occupancy.availableMinutes).toBe(480);
    expect(occupancy.busyMinutes).toBe(60); // 09:30–10:00 y 11:00–11:30
    expect(occupancy.overflowMinutes).toBe(60); // la hora tapada por el bloqueo
  });

  it("dos citas encimadas ocupan la silla una sola vez", () => {
    // La API de EA acepta citas encimadas, así que llegan de verdad. Contarlas
    // dos veces daría más del 100 % sin que nada falle.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [
        cita("2026-08-31 09:00:00", "2026-08-31 11:00:00"),
        cita("2026-08-31 10:00:00", "2026-08-31 12:00:00"),
      ],
    });

    expect(occupancy.busyMinutes).toBe(180);
  });

  it("lo trabajado fuera de la jornada se reporta aparte, no se descarta", () => {
    // Serían minutos trabajados que ningún reporte ve. Que aparezcan es la
    // señal de que el plan de trabajo cargado en EA no es el real.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [cita("2026-08-31 17:00:00", "2026-08-31 20:00:00")],
    });

    expect(occupancy.busyMinutes).toBe(60);
    expect(occupancy.overflowMinutes).toBe(120);
    // Y la tasa se queda en su rango: 60/540, no 180/540.
    expect(occupancy.rate).toBeCloseTo(60 / 540, 10);
  });

  it("un día sin plan de trabajo no tiene ocupación: null, no cero", () => {
    // Promediar ceros de domingos cerrados hunde el mes entero.
    const domingo = computeOccupancy({ scheduled: [], blocked: [], appointments: [] });

    expect(domingo.availableMinutes).toBe(0);
    expect(domingo.rate).toBeNull();
  });

  it("un día bloqueado entero tampoco", () => {
    const festivo = computeOccupancy({
      scheduled: JORNADA,
      blocked: JORNADA,
      appointments: [],
    });

    expect(festivo.availableMinutes).toBe(0);
    expect(festivo.rate).toBeNull();
  });

  it("tramos partidos por un descanso se fusionan bien", () => {
    const occupancy = computeOccupancy({
      scheduled: [
        span("2026-08-31 09:00:00", "2026-08-31 13:00:00"),
        span("2026-08-31 14:00:00", "2026-08-31 18:00:00"),
      ],
      blocked: [],
      appointments: [cita("2026-08-31 12:00:00", "2026-08-31 15:00:00")],
    });

    expect(occupancy.availableMinutes).toBe(480);
    expect(occupancy.busyMinutes).toBe(120); // la hora del descanso no cuenta
    expect(occupancy.overflowMinutes).toBe(60);
  });

  it("tramos solapados en el plan no duplican el denominador", () => {
    const occupancy = computeOccupancy({
      scheduled: [
        span("2026-08-31 09:00:00", "2026-08-31 14:00:00"),
        span("2026-08-31 13:00:00", "2026-08-31 18:00:00"),
      ],
      blocked: [],
      appointments: [],
    });

    expect(occupancy.availableMinutes).toBe(540);
  });

  it("dos tramos que arrancan a la misma hora se fusionan al más largo", () => {
    // El desempate del orden por hora de fin. Sin él, el tramo corto podría
    // procesarse primero y el largo quedar partido en dos.
    const occupancy = computeOccupancy({
      scheduled: [
        span("2026-08-31 09:00:00", "2026-08-31 12:00:00"),
        span("2026-08-31 09:00:00", "2026-08-31 14:00:00"),
      ],
      blocked: [],
      appointments: [],
    });

    expect(occupancy.availableMinutes).toBe(300);
  });

  it("un bloqueo que termina antes de que abra el estudio no resta nada", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [
        span("2026-08-31 07:00:00", "2026-08-31 08:00:00"),
        span("2026-08-31 13:00:00", "2026-08-31 14:00:00"),
      ],
      appointments: [],
    });

    expect(occupancy.availableMinutes).toBe(480);
  });

  it("una cita enteramente fuera de la jornada es todo desborde", () => {
    // No cruza en ningún minuto con la ventana disponible: el numerador queda
    // en cero y los minutos trabajados igual se reportan.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [
        cita("2026-08-31 20:00:00", "2026-08-31 21:00:00"),
        cita("2026-08-31 10:00:00", "2026-08-31 11:00:00"),
      ],
    });

    expect(occupancy.busyMinutes).toBe(60);
    expect(occupancy.overflowMinutes).toBe(60);
  });

  it("una cita de duración cero aporta cero", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [cita("2026-08-31 10:00:00", "2026-08-31 10:00:00")],
    });

    expect(occupancy.busyMinutes).toBe(0);
    expect(occupancy.overflowMinutes).toBe(0);
  });

  it("un bloqueo fuera de la jornada no resta nada", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [span("2026-08-31 20:00:00", "2026-08-31 22:00:00")],
      appointments: [],
    });

    expect(occupancy.availableMinutes).toBe(540);
  });

  it("un bloqueo que empieza antes de la jornada la recorta por delante", () => {
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [span("2026-08-31 07:00:00", "2026-08-31 10:00:00")],
      appointments: [],
    });

    expect(occupancy.availableMinutes).toBe(480);
  });

  it("un tramo que termina antes de empezar revienta en vez de restar minutos", () => {
    expect(() =>
      computeOccupancy({
        scheduled: [span("2026-08-31 18:00:00", "2026-08-31 09:00:00")],
        blocked: [],
        appointments: [],
      }),
    ).toThrow(MetricsError);

    expect(() =>
      computeOccupancy({
        scheduled: JORNADA,
        blocked: [span("2026-08-31 12:00:00", "2026-08-31 11:00:00")],
        appointments: [],
      }),
    ).toThrow(/bloqueo/i);

    expect(() =>
      computeOccupancy({
        scheduled: JORNADA,
        blocked: [],
        appointments: [cita("2026-08-31 12:00:00", "2026-08-31 11:00:00")],
      }),
    ).toThrow(/cita/i);
  });

  it("da lo mismo en cualquier zona del proceso", () => {
    // Toda la aritmética pasa por `eaLocalToInstant()`, que ancla en Bogotá sin
    // mirar la zona del proceso. Sin eso, CI en UTC y la VM darían ocupaciones
    // distintas para el mismo día.
    const occupancy = computeOccupancy({
      scheduled: JORNADA,
      blocked: [],
      appointments: [cita("2026-08-31 09:00:00", "2026-08-31 18:00:00")],
    });

    expect(occupancy.rate).toBe(1);
  });
});

// ── Clientas ────────────────────────────────────────────────────────────────

const visita = (customerKey: string, atValue: string, attended = true): VisitRecord => ({
  customerKey,
  at: at(atValue),
  attended,
});

const AGOSTO = { from: day("2026-08-01"), to: day("2026-08-31") };

describe("clienta nueva — sobre la unión EA + legacy", () => {
  it("sin ninguna visita previa es nueva", () => {
    const visits = [visita("+573001112233", "2026-08-10 10:00:00")];

    expect(splitCustomers(visits, AGOSTO)).toEqual({
      newCustomers: ["+573001112233"],
      returningCustomers: [],
    });
  });

  it("una visita heredada de Agenda Pro la vuelve conocida", () => {
    // Éste es el caso que hace que la unión importe: con solo las citas de EA,
    // media clientela heredada contaría como nueva y el reporte diría que la
    // captación funciona cuando no pasó nada.
    const visits = [
      visita("+573001112233", "2024-11-02 15:00:00"), // legacy_appointment
      visita("+573001112233", "2026-08-10 10:00:00"), // EA
    ];

    expect(splitCustomers(visits, AGOSTO)).toEqual({
      newCustomers: [],
      returningCustomers: ["+573001112233"],
    });
  });

  it("dos visitas dentro del mismo periodo no la vuelven conocida", () => {
    // Se compara contra su PRIMERA visita del periodo, no contra el inicio del
    // periodo: si no, la segunda visita de agosto la sacaría de "nuevas".
    const visits = [
      visita("+573001112233", "2026-08-03 10:00:00"),
      visita("+573001112233", "2026-08-20 10:00:00"),
    ];

    expect(splitCustomers(visits, AGOSTO).newCustomers).toEqual(["+573001112233"]);
  });

  it("una inasistencia previa no la vuelve conocida", () => {
    // Nunca estuvo en la silla, y el reporte que usa esto es sobre gente a la
    // que el estudio efectivamente atendió.
    const visits = [
      visita("+573001112233", "2026-05-02 15:00:00", false),
      visita("+573001112233", "2026-08-10 10:00:00"),
    ];

    expect(splitCustomers(visits, AGOSTO).newCustomers).toEqual(["+573001112233"]);
  });

  it("una inasistencia dentro del periodo no la mete a ninguna lista", () => {
    const visits = [visita("+573001112233", "2026-08-10 10:00:00", false)];

    expect(splitCustomers(visits, AGOSTO)).toEqual({ newCustomers: [], returningCustomers: [] });
  });

  it("ignora a quien no vino en el periodo", () => {
    const visits = [visita("+573009998877", "2026-07-10 10:00:00")];

    expect(splitCustomers(visits, AGOSTO)).toEqual({ newCustomers: [], returningCustomers: [] });
  });

  it("los extremos del periodo son inclusivos", () => {
    const visits = [
      visita("+57300A", "2026-08-01 09:00:00"),
      visita("+57300B", "2026-08-31 23:59:59"),
      visita("+57300C", "2026-07-31 23:59:59"),
      visita("+57300D", "2026-09-01 00:00:00"),
    ];

    expect(splitCustomers(visits, AGOSTO).newCustomers).toEqual(["+57300A", "+57300B"]);
  });

  it("las listas salen ordenadas para que el reporte no cambie de orden", () => {
    const visits = [
      visita("+57300C", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-08-11 10:00:00"),
      visita("+57300B", "2026-08-12 10:00:00"),
    ];

    expect(splitCustomers(visits, AGOSTO).newCustomers).toEqual(["+57300A", "+57300B", "+57300C"]);
  });

  it("isNewCustomer resuelve el caso de una sola clienta", () => {
    const visits = [visita("+57300A", "2026-05-01 10:00:00")];

    expect(isNewCustomer("+57300A", visits, at("2026-08-10 10:00:00"))).toBe(false);
    expect(isNewCustomer("+57300B", visits, at("2026-08-10 10:00:00"))).toBe(true);
    // Su propia visita no la vuelve conocida de sí misma.
    expect(isNewCustomer("+57300A", visits, at("2026-05-01 10:00:00"))).toBe(true);
  });
});

describe("retención a 60 días", () => {
  const AHORA = at("2026-12-01 00:00:00");

  it("volvió dentro de la ventana", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-09-20 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA })).toEqual({
      cohort: 1,
      returned: 1,
      pending: 0,
      rate: 1,
    });
  });

  it("volvió, pero tarde", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-11-20 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA })).toMatchObject({ returned: 0, rate: 0 });
  });

  it("el día 60 exacto todavía cuenta", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-10-09 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA }).returned).toBe(1);
  });

  it("el día 61 ya no", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-10-09 10:00:01"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA }).returned).toBe(0);
  });

  it("se mide desde su ÚLTIMA visita del periodo, no la primera", () => {
    // Con la primera, una clienta que vino dos veces en agosto contaría como
    // retenida sin haber vuelto nunca después del periodo: la retención
    // mediría frecuencia en vez de regreso.
    const visits = [
      visita("+57300A", "2026-08-03 10:00:00"),
      visita("+57300A", "2026-08-28 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA })).toMatchObject({
      cohort: 1,
      returned: 0,
    });
  });

  it("el orden en que llegan las visitas no cambia el resultado", () => {
    // Las filas salen de una consulta SQL y nadie garantiza el orden. Si el
    // motor dependiera de él, la retención cambiaría entre dos corridas del
    // mismo reporte.
    const cronologico = [
      visita("+57300A", "2026-08-03 10:00:00"),
      visita("+57300A", "2026-08-28 10:00:00"),
      visita("+57300A", "2026-09-30 10:00:00"),
    ];

    const revuelto = [cronologico[1], cronologico[2], cronologico[0]];

    expect(retentionRate(revuelto, AGOSTO, { now: AHORA })).toEqual(
      retentionRate(cronologico, AGOSTO, { now: AHORA }),
    );
    expect(retentionRate(revuelto, AGOSTO, { now: AHORA }).returned).toBe(1);
  });

  it("una cohorte a medio medir sale como PENDIENTE, no como perdida", () => {
    // Un número que se mueve solo dos meses después es un número en el que
    // nadie va a confiar. Las pendientes salen del denominador.
    const visits = [
      visita("+57300A", "2026-08-20 10:00:00"),
      visita("+57300B", "2026-08-05 10:00:00"),
      visita("+57300B", "2026-08-30 10:00:00"),
    ];

    const result = retentionRate(visits, AGOSTO, { now: at("2026-09-15 00:00:00") });

    expect(result).toEqual({ cohort: 2, returned: 0, pending: 2, rate: null });
  });

  it("una cohorte vacía no tiene retención", () => {
    expect(retentionRate([], AGOSTO, { now: AHORA })).toEqual({
      cohort: 0,
      returned: 0,
      pending: 0,
      rate: null,
    });
  });

  it("las inasistencias no forman cohorte ni cuentan como regreso", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-09-01 10:00:00", false),
      visita("+57300B", "2026-08-10 10:00:00", false),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA })).toMatchObject({
      cohort: 1,
      returned: 0,
    });
  });

  it("mezcla de vueltas y no vueltas", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-09-05 10:00:00"),
      visita("+57300B", "2026-08-11 10:00:00"),
      visita("+57300C", "2026-08-12 10:00:00"),
      visita("+57300C", "2026-09-30 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA })).toEqual({
      cohort: 3,
      returned: 2,
      pending: 0,
      rate: 2 / 3,
    });
  });

  it("la ventana es configurable pero tiene que ser días enteros positivos", () => {
    const visits = [
      visita("+57300A", "2026-08-10 10:00:00"),
      visita("+57300A", "2026-08-25 10:00:00"),
    ];

    expect(retentionRate(visits, AGOSTO, { now: AHORA, windowDays: 30 }).returned).toBe(0);
    expect(() => retentionRate(visits, AGOSTO, { now: AHORA, windowDays: 0 })).toThrow(MetricsError);
    expect(() => retentionRate(visits, AGOSTO, { now: AHORA, windowDays: -1 })).toThrow(/ventana/);
    expect(() => retentionRate(visits, AGOSTO, { now: AHORA, windowDays: 1.5 })).toThrow(/ventana/);
  });
});

describe("ingreso por hora de silla", () => {
  it("la cifra que el plan pone como ejemplo", () => {
    // Un combo de $95k en 120 min rinde más por minuto que un montaje de $115k
    // en 150. Es el reporte que Agenda Pro no daba y el que más plata mueve.
    const combo = revenuePerChairHour(95_000, 120);
    const montaje = revenuePerChairHour(115_000, 150);

    expect(combo).toBe(47_500);
    expect(montaje).toBe(46_000);
    expect(combo).toBeGreaterThan(montaje as number);
  });

  it("cero minutos no es infinito: es null", () => {
    expect(revenuePerChairHour(100_000, 0)).toBeNull();
  });

  it("rechaza entradas imposibles", () => {
    expect(() => revenuePerChairHour(1_000.5, 60)).toThrow(MetricsError);
    expect(() => revenuePerChairHour(1_000, -1)).toThrow(/minutos/);
    expect(() => revenuePerChairHour(1_000, Number.NaN)).toThrow(/minutos/);
  });

  it("chairHourRanking agrupa, calcula y ordena de mayor a menor", () => {
    const ranking = chairHourRanking([
      { key: "acrylic-sculpted", revenue: 115_000, minutes: 150 },
      { key: "semi-permanent-hands-feet", revenue: 95_000, minutes: 120 },
      { key: "acrylic-sculpted", revenue: 115_000, minutes: 150 },
    ]);

    expect(ranking).toEqual([
      { key: "semi-permanent-hands-feet", revenue: 95_000, minutes: 120, perHour: 47_500 },
      { key: "acrylic-sculpted", revenue: 230_000, minutes: 300, perHour: 46_000 },
    ]);
  });

  it("las filas sin minutos van al final, no al principio", () => {
    // Un `null` ordenado como infinito encabezaría el reporte, y la primera
    // fila es la que se lee.
    const ranking = chairHourRanking([
      { key: "sin-minutos", revenue: 50_000, minutes: 0 },
      { key: "con-minutos", revenue: 10_000, minutes: 60 },
      { key: "otro-sin-minutos", revenue: 1_000, minutes: 0 },
    ]);

    expect(ranking.map((r) => r.key)).toEqual(["con-minutos", "sin-minutos", "otro-sin-minutos"]);
    expect(ranking[1].perHour).toBeNull();
  });

  it("un ranking vacío es una lista vacía", () => {
    expect(chairHourRanking([])).toEqual([]);
  });
});
