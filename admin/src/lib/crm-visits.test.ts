import { describe, expect, it } from "vitest";

import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea";
import type { AppointmentWithRelations } from "@/lib/ea/client";

import { buildCrmVisits, crmVisitStatus, crmVisitsRange, shiftDate } from "./crm-visits";

/**
 * Las visitas que el panel le manda al CRM desde que se apagó Agenda Pro. De
 * acá salen el win-back y los sellos de Stampee, así que lo que importa es que
 * una visita que no ocurrió nunca llegue como `completed`, y que el barrido del
 * CRM nunca alcance un día anterior al corte.
 */

const d = (s: string) => s as EaLocalDate;

function fila(over: {
  id?: number;
  status?: string;
  start?: string;
  phone?: string | null;
  customer?: null;
  service?: string;
}): AppointmentWithRelations {
  return {
    appointment: {
      id: over.id ?? 501,
      status: over.status ?? "Reservada",
      start: (over.start ?? "2026-10-24 10:00:00") as EaLocalDateTime,
      end: "2026-10-24 12:00:00" as EaLocalDateTime,
    },
    customer:
      over.customer === null
        ? null
        : { firstName: "Ana", lastName: "Ruiz", phone: over.phone === undefined ? "300 123 4567" : over.phone, email: null },
    service: { name: over.service ?? "Forrado polygel", price: 95000 },
    provider: null,
  } as unknown as AppointmentWithRelations;
}

describe("crmVisitStatus", () => {
  it("una cuenta cerrada es una visita hecha, aunque EA siga en Reservada", () => {
    expect(crmVisitStatus("Reservada", true)).toBe("completed");
  });

  it("no asistió y cancelada no son visitas: no arrancan el win-back", () => {
    expect(crmVisitStatus("No asistió", false)).toBe("cancelled");
    expect(crmVisitStatus("Cancelada", false)).toBe("cancelled");
  });

  it("completada en EA cuenta; lo demás queda por venir", () => {
    expect(crmVisitStatus("Completada", false)).toBe("completed");
    expect(crmVisitStatus("Confirmada", false)).toBe("upcoming");
    expect(crmVisitStatus("", false)).toBe("upcoming");
  });
});

describe("crmVisitsRange", () => {
  it("nunca empieza antes del corte: el barrido del CRM no toca la historia de Agenda Pro", () => {
    const r = crmVisitsRange({ today: d("2026-10-26"), since: d("2026-10-24"), lookbackDays: 7, lookaheadDays: 60 });
    expect(r.from).toBe("2026-10-24");
    // El CRM barre ESTRICTAMENTE adentro de la ventana, por eso va un día más ancha.
    expect(r.window.start).toBe("2026-10-23");
    expect(r.window.start < r.from).toBe(true);
    expect(r.till).toBe("2026-12-25");
    expect(r.window.end).toBe("2026-12-26");
  });

  it("pasado el corte, mira hacia atrás lookbackDays", () => {
    const r = crmVisitsRange({ today: d("2026-12-01"), since: d("2026-10-24"), lookbackDays: 7, lookaheadDays: 60 });
    expect(r.from).toBe("2026-11-24");
  });

  it("shiftDate cruza meses y años", () => {
    expect(shiftDate(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(shiftDate(d("2026-03-01"), -1)).toBe("2026-02-28");
  });
});

describe("buildCrmVisits", () => {
  it("arma la visita con la llave de EA, la fecha de la cita y lo cobrado", () => {
    const [v] = buildCrmVisits([fila({})], new Map([[501, { closed: true, priceList: 95000, amountCharged: 90000 }]]));
    expect(v).toEqual({
      booking_id: "ea-appt:501",
      phone: "300 123 4567",
      full_name: "Ana Ruiz",
      email: null,
      service_name: "Forrado polygel",
      service_date: "2026-10-24",
      status: "completed",
      price_list: 95000,
      price_real: 90000,
    });
  });

  it("sin cuenta cerrada no manda precio real", () => {
    const [v] = buildCrmVisits([fila({ status: "Confirmada" })], new Map());
    expect(v?.status).toBe("upcoming");
    expect(v?.price_real).toBeNull();
    expect(v?.price_list).toBe(95000);
  });

  it("sin clienta o sin teléfono no hay visita: el CRM llavea por teléfono", () => {
    expect(buildCrmVisits([fila({ customer: null }), fila({ phone: "  " }), fila({ phone: null })], new Map())).toEqual([]);
  });
});
