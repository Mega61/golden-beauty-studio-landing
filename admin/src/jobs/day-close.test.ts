import { describe, expect, it } from "vitest";

import {
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "@/lib/ea";
import type { DayClose, PaymentMethod } from "@/db/types";

import {
  blockingIssues,
  dayBounds,
  reviewDay,
  summarizeDayTotals,
  summarizePush,
  totalsOf,
  type DayAccount,
  type DayAppointment,
  type PushOutcome,
} from "./day-close";

/**
 * Capa 1 de C3: la compuerta del cierre y los totales del día.
 *
 * Las dos son funciones puras y las dos deciden plata, así que se fijan con una
 * tabla de casos y no probándolas una vez a mano. La diferencia entre "el día
 * cerró" y "el día cerró con tres cuentas afuera" no se ve en pantalla: se ve
 * un mes después, cuando el ingreso de Actual Budget no cuadra y ya no hay
 * forma de saber desde cuándo.
 */

const DIA: EaLocalDate = parseEaLocalDate("2026-09-03");

/** Las 8 p. m. de ese día en Bogotá (UTC−5), como instante. */
const OCHO_PM = new Date("2026-09-04T01:00:00Z");
/** El mediodía de ese día. */
const MEDIODIA = new Date("2026-09-03T17:00:00Z");

function wall(time: string): EaLocalDateTime {
  return parseEaLocalDateTime(`2026-09-03 ${time}`);
}

function cita(over: Partial<DayAppointment> & { eaAppointmentId: number }): DayAppointment {
  return {
    status: "Completada",
    start: wall("09:00:00"),
    end: wall("10:30:00"),
    customerName: "Marcela",
    providerName: "Lina",
    ...over,
  };
}

function cuenta(
  over: Partial<DayAccount> & { eaAppointmentId: number; financeId: number },
): DayAccount {
  return {
    amountCharged: 180_000,
    tip: 0,
    paymentMethod: "efectivo",
    paidOn: DIA,
    eaProviderId: 3,
    performedServiceId: 5,
    closedAt: new Date("2026-09-03T15:40:00Z"),
    dayCloseId: null,
    pushedToIngestAt: null,
    ...over,
  };
}

/** Una cuenta que nadie cerró todavía. */
function abierta(eaAppointmentId: number, financeId: number): DayAccount {
  return cuenta({
    eaAppointmentId,
    financeId,
    amountCharged: null,
    paymentMethod: null,
    paidOn: null,
    closedAt: null,
  });
}

// ── Totales ─────────────────────────────────────────────────────────────────

describe("summarizeDayTotals", () => {
  it("reparte por método y deja la propina aparte", () => {
    const totals = summarizeDayTotals([
      cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: 180_000, tip: 20_000 }),
      cuenta({
        eaAppointmentId: 2,
        financeId: 2,
        amountCharged: 240_000,
        paymentMethod: "transferencia",
        tip: 10_000,
      }),
      cuenta({
        eaAppointmentId: 3,
        financeId: 3,
        amountCharged: 95_000,
        paymentMethod: "otro",
      }),
    ]);

    expect(totals.efectivo).toBe(180_000);
    expect(totals.transferencia).toBe(240_000);
    expect(totals.otro).toBe(95_000);
    expect(totals.tips).toBe(30_000);
    expect(totals.count).toBe(3);
    // La propina **no** está adentro: no es ingreso del estudio y sumarla
    // inflaría el mes con plata que es de la técnica.
    expect(totals.ingreso).toBe(515_000);
  });

  it("no cuenta las cuentas sin cerrar", () => {
    const totals = summarizeDayTotals([
      cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: 100_000 }),
      abierta(2, 2),
    ]);

    expect(totals.count).toBe(1);
    expect(totals.ingreso).toBe(100_000);
  });

  it("aparta lo cobrado sin método en vez de perderlo", () => {
    const totals = summarizeDayTotals([
      cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: 70_000, paymentMethod: null }),
    ]);

    // Si esto cayera en cualquiera de las tres columnas, el total del día
    // cuadraría con una cifra equivocada. Si no cayera en ninguna,
    // desaparecería de la pantalla.
    expect(totals.efectivo).toBe(0);
    expect(totals.transferencia).toBe(0);
    expect(totals.otro).toBe(0);
    expect(totals.sinMetodo).toBe(70_000);
    expect(totals.ingreso).toBe(70_000);
  });

  it("una cuenta cerrada sin monto cuenta como cero, marcada aparte", () => {
    const totals = summarizeDayTotals([
      cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: null }),
    ]);
    expect(totals.count).toBe(1);
    expect(totals.ingreso).toBe(0);
  });

  it("un día vacío da todo en cero", () => {
    expect(summarizeDayTotals([])).toEqual({
      efectivo: 0,
      transferencia: 0,
      otro: 0,
      sinMetodo: 0,
      tips: 0,
      count: 0,
      ingreso: 0,
    });
  });
});

describe("totalsOf", () => {
  it("lee los totales de una fila de cierre", () => {
    const row: DayClose = {
      id: 7,
      close_date: DIA,
      total_efectivo: 180_000,
      total_transferencia: 240_000,
      total_otro: 0,
      total_tips: 30_000,
      appointment_count: 2,
      closed_by: "usr_1",
      closed_at: OCHO_PM,
      pushed_to_ingest_at: null,
      created_at: OCHO_PM,
    };

    const totals = totalsOf(row);
    expect(totals.ingreso).toBe(420_000);
    expect(totals.tips).toBe(30_000);
    // La fila no guarda "sin método": si el día cerró, no quedaba ninguna.
    expect(totals.sinMetodo).toBe(0);
  });
});

describe("summarizePush", () => {
  const row: DayClose = {
    id: 7,
    close_date: DIA,
    total_efectivo: 180_000,
    total_transferencia: 0,
    total_otro: 0,
    total_tips: 0,
    appointment_count: 1,
    closed_by: "usr_1",
    closed_at: OCHO_PM,
    pushed_to_ingest_at: null,
    created_at: OCHO_PM,
  };

  /**
   * Es el resumen que queda en `job_run` cada vez que el push se intenta.
   *
   * Existe porque `pushed_to_ingest_at` dice si el push **llegó**, no si se
   * intentó: "no había nada que empujar" y "el push está apagado" no dejan
   * marca en ninguna otra parte, y son justo los casos que se confunden con
   * "nadie apretó el botón".
   */
  it("nombra el día en los seis resultados posibles", () => {
    const outcomes: PushOutcome[] = [
      { state: "hecho", at: OCHO_PM, sent: 3 },
      { state: "ya", at: OCHO_PM },
      { state: "vacio" },
      { state: "apagado" },
      { state: "pendiente" },
      { state: "fallo", message: "ingest respondió 502", retryable: true },
    ];

    for (const outcome of outcomes) {
      expect(summarizePush(row, outcome), outcome.state).toContain(DIA);
    }
  });

  it("dice cuántos movimientos salieron, y por qué falló cuando falla", () => {
    expect(summarizePush(row, { state: "hecho", at: OCHO_PM, sent: 3 })).toContain(
      "3 movimiento(s)",
    );
    expect(
      summarizePush(row, { state: "fallo", message: "ingest respondió 502", retryable: true }),
    ).toContain("ingest respondió 502");
    // "Apagado" no es un fallo: hoy el contrato del cuerpo no está verificado
    // contra el CRM y cerrar la caja no puede depender de eso. Que el resumen
    // lo diga es lo que evita que alguien lo lea como un error.
    expect(summarizePush(row, { state: "apagado" })).toContain("INGEST_URL");
  });
});

describe("dayBounds", () => {
  it("abarca 24 horas desde la medianoche del estudio", () => {
    const [from, to] = dayBounds(DIA);
    // Bogotá es UTC−5 todo el año: la medianoche local son las 05:00 UTC.
    expect(from.toISOString()).toBe("2026-09-03T05:00:00.000Z");
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

// ── La compuerta ────────────────────────────────────────────────────────────

describe("reviewDay", () => {
  it("deja cerrar un día sin pendientes", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 }), cita({ eaAppointmentId: 2 })],
      accounts: [
        cuenta({ eaAppointmentId: 1, financeId: 1 }),
        cuenta({ eaAppointmentId: 2, financeId: 2, amountCharged: 240_000 }),
      ],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(true);
    expect(review.issues).toHaveLength(0);
    expect(review.closed).toHaveLength(2);
    expect(review.totals.ingreso).toBe(420_000);
  });

  it("NO deja cerrar con una cita completada sin cuenta", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(blockingIssues(review)).toHaveLength(1);
    expect(review.issues[0]?.kind).toBe("sin-cuenta");
    expect(review.issues[0]?.customerName).toBe("Marcela");
  });

  it("una cita con fila de plata pero sin cerrar sigue siendo pendiente", () => {
    // Es el caso normal: el webhook creó la fila con el snapshot de precio y
    // nadie cerró la cuenta todavía. Que la fila exista no es que la cuenta
    // esté cerrada.
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [abierta(1, 1)],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.kind).toBe("sin-cuenta");
    expect(review.closed).toHaveLength(0);
  });

  it("bloquea una cita que ya terminó aunque su estado no diga completada", () => {
    // El estudio puede no marcar "Completada" nunca. Si eso dejara pasar el
    // cierre, el día cerraría sin las cuentas que sí existían — y en silencio,
    // que es el modo de falla que este paquete existe para no tener.
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1, status: "Confirmada" })],
      accounts: [],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.kind).toBe("sin-cuenta");
  });

  it("una cita que todavía no terminó se muestra y NO bloquea", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [
        cita({
          eaAppointmentId: 1,
          status: "Confirmada",
          start: wall("16:00:00"),
          end: wall("17:30:00"),
        }),
      ],
      accounts: [],
      now: MEDIODIA,
    });

    // La lista de pendientes se consulta desde el celular a media tarde: tiene
    // que decir qué falta *y* qué viene, sin que lo que viene bloquee nada.
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]?.kind).toBe("en-curso");
    expect(review.issues[0]?.blocks).toBe(false);
    expect(review.canClose).toBe(true);
  });

  it("una cita completada bloquea aunque no haya terminado en el reloj", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [
        cita({ eaAppointmentId: 1, start: wall("16:00:00"), end: wall("17:30:00") }),
      ],
      accounts: [],
      now: MEDIODIA,
    });

    expect(review.issues[0]?.kind).toBe("sin-cuenta");
    expect(review.canClose).toBe(false);
  });

  it.each(["Cancelada", "No asistió", "Cancelled"])(
    "%s sin cuenta no es un pendiente",
    (status) => {
      const review = reviewDay({
        date: DIA,
        appointments: [cita({ eaAppointmentId: 1, status })],
        accounts: [],
        now: OCHO_PM,
      });

      expect(review.issues).toHaveLength(0);
      expect(review.canClose).toBe(true);
    },
  );

  it("una inasistencia CON cuenta cerrada entra al cierre", () => {
    // El retoque de garantía es un renglón manual en cero, y una inasistencia
    // que igual se cobró es plata que existe. La cuenta manda sobre el estado.
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1, status: "No asistió" })],
      accounts: [cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: 50_000 })],
      now: OCHO_PM,
    });

    expect(review.closed).toHaveLength(1);
    expect(review.totals.efectivo).toBe(50_000);
    expect(review.canClose).toBe(true);
  });

  it("un estado que el panel no reconoce, ya terminado, bloquea", () => {
    // Punteado y sin traducir es la señal que Diagnóstico necesita; dejarlo
    // pasar sería suponer que un estado desconocido no cobra.
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1, status: "Pendiente de pago" })],
      accounts: [],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.kind).toBe("sin-cuenta");
  });

  it("NO deja cerrar con una cuenta cerrada sin método de pago", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [
        cuenta({ eaAppointmentId: 1, financeId: 1, paymentMethod: null, paidOn: null }),
      ],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.kind).toBe("cuenta-incompleta");
    expect(review.issues[0]?.message).toContain("método de pago");
    // Y la plata sigue visible, apartada.
    expect(review.totals.sinMetodo).toBe(180_000);
  });

  it("NO deja cerrar con una cuenta cerrada sin monto", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: null })],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.message).toContain("monto cobrado");
  });

  it("NO deja cerrar con una cuenta cerrada sin fecha de caja", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [cuenta({ eaAppointmentId: 1, financeId: 1, paidOn: null })],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.issues[0]?.message).toContain("fecha de caja");
  });

  it("nombra una cuenta incompleta cuya cita EA no devolvió", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [],
      accounts: [cuenta({ eaAppointmentId: 42, financeId: 1, paymentMethod: null })],
      now: OCHO_PM,
    });

    expect(review.issues[0]?.customerName).toBe("Cita #42");
    expect(review.issues[0]?.start).toBeNull();
  });

  it("sin agenda no se cierra, y lo dice", () => {
    // `appointments: null` = EA no respondió. La única forma de saber qué citas
    // hubo es preguntárselo a EA; cerrar a ciegas empujaría un día al que le
    // falta la mitad, y Actual no actualiza montos.
    const review = reviewDay({
      date: DIA,
      appointments: null,
      accounts: [cuenta({ eaAppointmentId: 1, financeId: 1 })],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.blockers).toHaveLength(1);
    expect(review.blockers[0]).toContain("agenda no responde");
    // Pero las cuentas y los totales se ven igual: `gbs_admin` sí contestó.
    expect(review.closed).toHaveLength(1);
    expect(review.totals.ingreso).toBe(180_000);
  });

  it("un total por método negativo bloquea con explicación", () => {
    // El CHECK `ck_day_close_totals` lo rechazaría de todos modos, pero como un
    // error de SQL en mitad del cierre. Acá se convierte en una frase.
    const review = reviewDay({
      date: DIA,
      appointments: [cita({ eaAppointmentId: 1 })],
      accounts: [cuenta({ eaAppointmentId: 1, financeId: 1, amountCharged: -5_000 })],
      now: OCHO_PM,
    });

    expect(review.canClose).toBe(false);
    expect(review.blockers.join(" ")).toContain("negativo");
  });

  it("ordena los pendientes por hora de cita", () => {
    const review = reviewDay({
      date: DIA,
      appointments: [
        cita({ eaAppointmentId: 3, start: wall("14:00:00"), end: wall("15:00:00") }),
        cita({ eaAppointmentId: 1, start: wall("09:00:00"), end: wall("10:00:00") }),
        cita({ eaAppointmentId: 2, start: wall("11:00:00"), end: wall("12:00:00") }),
      ],
      accounts: [],
      now: OCHO_PM,
    });

    expect(review.issues.map((i) => i.eaAppointmentId)).toEqual([1, 2, 3]);
  });

  it("un día sin citas y sin cuentas se puede cerrar", () => {
    // Un domingo. Cerrarlo produce un lote vacío, que no se manda.
    const review = reviewDay({ date: DIA, appointments: [], accounts: [], now: OCHO_PM });
    expect(review.canClose).toBe(true);
    expect(review.totals.count).toBe(0);
  });

  it.each<PaymentMethod>(["efectivo", "transferencia", "otro"])(
    "acepta el método %s sin marcarlo incompleto",
    (paymentMethod) => {
      const review = reviewDay({
        date: DIA,
        appointments: [cita({ eaAppointmentId: 1 })],
        accounts: [cuenta({ eaAppointmentId: 1, financeId: 1, paymentMethod })],
        now: OCHO_PM,
      });
      expect(review.canClose).toBe(true);
    },
  );
});
