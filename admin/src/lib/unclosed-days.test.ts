import { describe, expect, it } from "vitest";

import { eaLocalToInstant, parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import {
  buildUnclosedDaysPayload,
  findUnclosedDays,
  shiftEaDate,
  summarizeUnclosedDays,
  unclosedDaysFrom,
  unclosedTotal,
} from "./unclosed-days";

const d = parseEaLocalDate;
const at = (wall: string) => eaLocalToInstant(parseEaLocalDateTime(wall));
const account = (wall: string, amount: number | null, tip = 0) => ({
  appointment_start_at: at(wall),
  amount_charged: amount,
  tip,
});

const TODAY = d("2026-11-06");
const SINCE = d("2026-10-24");

describe("findUnclosedDays", () => {
  it("lo de octubre: cuentas cerradas sin cierre de caja, agrupadas por día y en orden", () => {
    const days = findUnclosedDays({
      accounts: [
        account("2026-10-30 17:30:00", 63_000),
        account("2026-10-27 14:00:00", 60_000),
        account("2026-10-27 17:30:00", 50_000, 5_000),
        account("2026-10-30 16:00:00", 70_000),
      ],
      closedDates: new Set(),
      from: SINCE,
      today: TODAY,
    });
    expect(days).toEqual([
      { date: "2026-10-27", kind: "sin-cierre", accounts: 2, total: 115_000 },
      { date: "2026-10-30", kind: "sin-cierre", accounts: 2, total: 133_000 },
    ]);
    expect(unclosedTotal(days)).toBe(248_000);
  });

  it("un día cerrado con una cuenta cerrada después queda como por fuera del cierre", () => {
    const days = findUnclosedDays({
      accounts: [account("2026-11-04 13:30:00", 70_000)],
      closedDates: new Set(["2026-11-04"]),
      from: SINCE,
      today: TODAY,
    });
    expect(days).toEqual([{ date: "2026-11-04", kind: "por-fuera", accounts: 1, total: 70_000 }]);
  });

  it("hoy no cuenta: el día todavía no termina", () => {
    expect(
      findUnclosedDays({
        accounts: [account("2026-11-06 10:00:00", 50_000)],
        closedDates: new Set(),
        from: SINCE,
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it("lo anterior al corte no cuenta: esa plata entró a Actual por Agenda Pro", () => {
    expect(
      findUnclosedDays({
        accounts: [account("2026-10-23 15:00:00", 81_000)],
        closedDates: new Set(),
        from: SINCE,
        today: TODAY,
      }),
    ).toEqual([]);
  });

  it("agrupa por el día de Bogotá, no por el de UTC: una cita de las 8 p. m. es de ese día", () => {
    const days = findUnclosedDays({
      accounts: [account("2026-10-31 20:00:00", 90_000)],
      closedDates: new Set(),
      from: SINCE,
      today: TODAY,
    });
    expect(days.map((day) => day.date)).toEqual(["2026-10-31"]);
  });

  it("una cortesía cuenta como cuenta sin cierre y suma cero", () => {
    const days = findUnclosedDays({
      accounts: [account("2026-11-04 13:30:00", 0), account("2026-11-04 15:00:00", null)],
      closedDates: new Set(),
      from: SINCE,
      today: TODAY,
    });
    expect(days).toEqual([{ date: "2026-11-04", kind: "sin-cierre", accounts: 2, total: 0 }]);
  });

  it("una fila sin hora de cita se ignora", () => {
    expect(
      findUnclosedDays({
        accounts: [{ appointment_start_at: null, amount_charged: 10_000, tip: 0 }],
        closedDates: new Set(),
        from: SINCE,
        today: TODAY,
      }),
    ).toEqual([]);
  });
});

describe("unclosedDaysFrom", () => {
  it("con INGEST_SINCE, desde el corte", () => {
    expect(unclosedDaysFrom({ INGEST_SINCE: " 2026-10-24 " }, TODAY)).toBe("2026-10-24");
  });

  it("sin INGEST_SINCE, o con una fecha mal escrita, los últimos 60 días", () => {
    expect(unclosedDaysFrom({}, TODAY)).toBe(shiftEaDate(TODAY, -60));
    expect(unclosedDaysFrom({ INGEST_SINCE: "24/10/2026" }, TODAY)).toBe("2026-09-07");
  });
});

describe("buildUnclosedDaysPayload", () => {
  const DAYS = findUnclosedDays({
    accounts: [account("2026-10-27 14:00:00", 60_000), account("2026-10-31 13:00:00", 90_000)],
    closedDates: new Set(),
    from: SINCE,
    today: TODAY,
  });

  it("nada que avisar, nada que mandar", () => {
    expect(buildUnclosedDaysPayload([], TODAY, "/admin")).toBeNull();
  });

  it("dice cuántos días y cuánta plata, y abre Caja en el día más viejo", () => {
    const payload = buildUnclosedDaysPayload(DAYS, TODAY, "/admin/");
    expect(payload?.title).toBe("Hay 2 días de caja sin cerrar");
    expect(payload?.body).toContain("mar 27 oct, sáb 31 oct");
    expect(payload?.body).toContain("$ 150.000");
    expect(payload?.url).toBe("/admin/caja?fecha=2026-10-27");
    expect(payload?.tag).toBe("caja-sin-cerrar");
  });

  it("solo cuentas por fuera de un cierre: no dice que haya días sin cerrar", () => {
    const payload = buildUnclosedDaysPayload(
      [{ date: d("2026-11-04"), kind: "por-fuera", accounts: 1, total: 70_000 }],
      TODAY,
      "/admin",
    );
    expect(payload?.title).toBe("Hay cuentas por fuera del cierre de caja");
  });
});

describe("summarizeUnclosedDays", () => {
  it("cabe en una línea de job_run", () => {
    expect(summarizeUnclosedDays([])).toBe("días sin cerrar: ninguno");
    expect(
      summarizeUnclosedDays([
        { date: d("2026-10-27"), kind: "sin-cierre", accounts: 4, total: 216_500 },
        { date: d("2026-11-04"), kind: "por-fuera", accounts: 1, total: 70_000 },
      ]),
    ).toBe("días sin cerrar: 2026-10-27 (4), 2026-11-04 (1, por fuera) · $ 286.500");
  });
});
