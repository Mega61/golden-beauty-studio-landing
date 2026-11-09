import { describe, expect, it } from "vitest";

import { eaLocalToInstant, parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import type { DayAccount, DayAppointment } from "./day-close";
import { collectPendingCharges } from "./pending-charges";

/**
 * Qué cuenta como pendiente de cobro en varios días a la vez. La regla es la de
 * `reviewDay()`; lo que se prueba acá es el cruce por día.
 */

const d = parseEaLocalDate;
const NOW = eaLocalToInstant(parseEaLocalDateTime("2026-11-09 08:00:00"));

function cita(id: number, day: string, status = "Completada"): DayAppointment {
  return {
    eaAppointmentId: id,
    status,
    start: parseEaLocalDateTime(`${day} 14:00:00`),
    end: parseEaLocalDateTime(`${day} 15:00:00`),
    customerName: `Clienta ${id}`,
    providerName: "Mariana",
  };
}

function cuenta(id: number, day: string, conMetodo = true): DayAccount {
  return {
    financeId: id,
    eaAppointmentId: id,
    amountCharged: 50_000,
    tip: 0,
    payments: conMetodo ? [{ method: "efectivo", amount: 50_000 }] : [],
    paidOn: conMetodo ? day : null,
    eaProviderId: 4,
    performedServiceId: 1,
    houseCourtesy: false,
    closedAt: new Date(),
    dayCloseId: null,
    pushedToIngestAt: null,
  };
}

describe("collectPendingCharges", () => {
  it("nombra la cita atendida sin cuenta y la cuenta sin método, cada una en su día", () => {
    const charges = collectPendingCharges({
      appointments: [
        cita(1, "2026-11-06"),
        cita(2, "2026-11-06"),
        cita(3, "2026-11-07", "Cancelada"),
        cita(4, "2026-11-08", "No asistió"),
        cita(5, "2026-11-08"),
      ],
      accounts: [cuenta(1, "2026-11-06"), cuenta(5, "2026-11-08", false)],
      from: d("2026-11-06"),
      till: d("2026-11-08"),
      now: NOW,
    });

    expect(charges.map((c) => [c.date, c.eaAppointmentId, c.kind])).toEqual([
      ["2026-11-06", 2, "sin-cobrar"],
      ["2026-11-08", 5, "incompleta"],
    ]);
    expect(charges[1].message).toBe("Falta el método de pago");
  });

  it("todo cobrado no deja nada", () => {
    expect(
      collectPendingCharges({
        appointments: [cita(1, "2026-11-06")],
        accounts: [cuenta(1, "2026-11-06")],
        from: d("2026-11-06"),
        till: d("2026-11-08"),
        now: NOW,
      }),
    ).toEqual([]);
  });
});
