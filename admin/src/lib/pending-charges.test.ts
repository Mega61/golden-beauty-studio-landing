import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea";

import {
  buildPendingChargesPayload,
  describePending,
  groupPendingByDay,
  pendingWindow,
  shiftEaDate,
  summarizePendingCharges,
  syncWindowFrom,
  type PendingCharge,
} from "./pending-charges";

const d = parseEaLocalDate;
const TODAY = d("2026-11-09");

function pendiente(
  over: Partial<Omit<PendingCharge, "date">> & { eaAppointmentId: number; date: string },
): PendingCharge {
  return {
    kind: "sin-cobrar",
    customerName: `Clienta ${over.eaAppointmentId}`,
    providerName: "Mariana",
    message: "Sin cobrar",
    ...over,
    date: d(over.date),
  };
}

describe("syncWindowFrom", () => {
  it("arranca en el corte de Agenda Pro", () => {
    expect(syncWindowFrom({ INGEST_SINCE: "2026-10-24" }, TODAY)).toBe("2026-10-24");
  });

  it("sin corte mira 60 días hacia atrás", () => {
    expect(syncWindowFrom({}, TODAY)).toBe(shiftEaDate(TODAY, -60));
  });
});

describe("pendingWindow", () => {
  it("la última semana hasta ayer", () => {
    expect(pendingWindow({ INGEST_SINCE: "2026-10-24" }, TODAY)).toEqual({
      from: "2026-11-02",
      till: "2026-11-08",
    });
  });

  it("nunca antes del corte", () => {
    expect(pendingWindow({ INGEST_SINCE: "2026-11-06" }, TODAY)).toEqual({
      from: "2026-11-06",
      till: "2026-11-08",
    });
  });

  it("con el corte hoy no hay días que mirar", () => {
    expect(pendingWindow({ INGEST_SINCE: "2026-11-09" }, TODAY)).toBeNull();
  });
});

describe("describePending", () => {
  it("nombra las dos clases por separado, en singular y plural", () => {
    expect(
      describePending([
        pendiente({ eaAppointmentId: 1, date: "2026-11-07" }),
        pendiente({ eaAppointmentId: 2, date: "2026-11-08" }),
        pendiente({ eaAppointmentId: 3, date: "2026-11-08", kind: "incompleta" }),
      ]),
    ).toBe("2 citas sin cobrar y 1 cuenta con datos por completar");
    expect(describePending([pendiente({ eaAppointmentId: 1, date: "2026-11-07" })])).toBe(
      "1 cita sin cobrar",
    );
    expect(describePending([])).toBe("");
  });
});

describe("groupPendingByDay", () => {
  it("agrupa por día, del más viejo al más nuevo", () => {
    const grupos = groupPendingByDay([
      pendiente({ eaAppointmentId: 3, date: "2026-11-08" }),
      pendiente({ eaAppointmentId: 1, date: "2026-11-06" }),
      pendiente({ eaAppointmentId: 2, date: "2026-11-08" }),
    ]);
    expect(grupos.map((g) => [g.date, g.charges.map((c) => c.eaAppointmentId)])).toEqual([
      ["2026-11-06", [1]],
      ["2026-11-08", [3, 2]],
    ]);
  });
});

describe("buildPendingChargesPayload", () => {
  it("sin pendientes no hay aviso", () => {
    expect(buildPendingChargesPayload([], TODAY, "/admin")).toBeNull();
  });

  it("lleva a Hoy en el día más viejo, no a Caja: se cobra en su día", () => {
    const payload = buildPendingChargesPayload(
      [
        pendiente({ eaAppointmentId: 2, date: "2026-11-08", customerName: "Laura" }),
        pendiente({ eaAppointmentId: 1, date: "2026-11-06", customerName: "Sara" }),
      ],
      TODAY,
      "/admin/",
    );
    expect(payload).toMatchObject({
      title: "Quedan 2 citas sin cobrar",
      url: "/admin/hoy?fecha=2026-11-06",
      tag: "caja-sin-cobrar",
    });
    expect(payload?.body).toContain("Laura, Sara");
    expect(payload?.body).not.toMatch(/cerr/i);
  });

  it("con muchas nombra tres y cuenta el resto", () => {
    const payload = buildPendingChargesPayload(
      [1, 2, 3, 4, 5].map((id) => pendiente({ eaAppointmentId: id, date: "2026-11-08" })),
      TODAY,
      "/admin",
    );
    expect(payload?.body).toContain("Clienta 1, Clienta 2, Clienta 3 y 2 más");
  });
});

describe("summarizePendingCharges", () => {
  it("una línea con los días y cuántas", () => {
    expect(summarizePendingCharges([])).toBe("citas sin cobrar: ninguna");
    expect(
      summarizePendingCharges([
        pendiente({ eaAppointmentId: 1, date: "2026-11-07" }),
        pendiente({ eaAppointmentId: 2, date: "2026-11-07", kind: "incompleta" }),
      ]),
    ).toBe("pendientes: 1 cita sin cobrar y 1 cuenta con datos por completar (2026-11-07×2)");
  });
});
