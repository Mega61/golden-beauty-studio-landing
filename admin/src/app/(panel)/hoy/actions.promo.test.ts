import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogService, TicketCatalog } from "@/components/ticket/catalog";
import type { CloseTicketInput, FirstVisitStatus } from "@/components/ticket/types";
import type { UserRole } from "@/db/types";

/**
 * La Server Action de cierre con **promos y un segundo servicio**, llamada
 * directamente.
 *
 * Lo que importa probar acá y no en `draft.promo.test.ts` es la frontera: el
 * navegador solo dice *si* aplicar la promo; el monto lo calcula el servidor
 * con su catálogo y el día de la cita **según EA**, y el motivo `promo` no se
 * puede mandar desde afuera. Se dobla el borde —sesión, base, EA, catálogo, la
 * pregunta al historial— y la decisión es la real.
 */

const LINA = 3;
const SEMI_PIES = 2;
const RUBBER = 1;
const DISENO = 10;

let session: { userId: string; role: UserRole; eaProviderId: number | null };
let existing: Record<string, unknown>;
let appointmentStart: string;
let historial: FirstVisitStatus;
let preguntasAlHistorial: number;
let writes: { what: string; args: unknown[] }[];

class ForbiddenError extends Error {}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

vi.mock("@/lib/dal", () => ({
  ForbiddenError,
  requireCapability: async () => session,
  requireOwnProvider: async () => {},
}));

function fakeRepos() {
  const record =
    (what: string) =>
    async (...args: unknown[]) => {
      writes.push({ what, args });
    };
  return {
    appointmentFinance: {
      findById: async () => existing,
      update: record("appointmentFinance.update"),
    },
    appointmentPayments: {
      listByFinanceId: async () => [],
      replaceForFinance: record("appointmentPayments.replaceForFinance"),
    },
    appointmentFinanceItems: {
      replaceForFinance: record("appointmentFinanceItems.replaceForFinance"),
    },
    auditLog: { append: record("auditLog.append") },
  };
}

const fakeDb = {
  transaction: () => ({
    execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(fakeDb),
  }),
};

vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/db/repositories", () => ({ repositories: () => fakeRepos() }));

vi.mock("@/lib/ea/client", () => ({
  createEaClient: () => ({
    appointments: {
      get: async (id: number) => ({
        id,
        providerId: LINA,
        serviceId: SEMI_PIES,
        customerId: 44,
        start: appointmentStart,
      }),
    },
  }),
  createCachedEaClient: () => ({}),
}));

vi.mock("@/jobs/snapshot", () => ({
  upsertAppointmentFinance: async () => ({ financeId: 91 }),
}));

vi.mock("./first-visit", () => ({
  detectFirstVisit: async () => {
    preguntasAlHistorial += 1;
    return historial;
  },
}));

function servicio(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Sencillos",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    servicio({ eaServiceId: RUBBER, name: "Rubber", listPrice: 70_000, pricingId: "rubber-base-leveling" }),
    servicio({ eaServiceId: SEMI_PIES, name: "Semipermanente pies", listPrice: 55_000, pricingId: "semi-permanent-feet" }),
    servicio({ eaServiceId: DISENO, name: "Diseño", listPrice: 10_000, isExtra: true, pricingId: "design-per-nail" }),
  ],
};

vi.mock("./catalog-server", () => ({ loadCatalogForClose: async () => CATALOGO }));

const { cerrarCuenta } = await import("./actions");

function fila(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 91,
    ea_appointment_id: 7001,
    booked_service_id: SEMI_PIES,
    service_price_snapshot: 55_000,
    performed_service_id: null,
    discount: 0,
    tip: 0,
    amount_charged: null,
    is_house_courtesy: 0,
    appointment_start_at: new Date("2026-10-14T15:00:00Z"),
    closed_at: null,
    day_close_id: null,
    ...over,
  };
}

function entrada(over: Partial<CloseTicketInput> = {}): CloseTicketInput {
  return {
    eaAppointmentId: 7001,
    performedServiceId: SEMI_PIES,
    extras: {},
    manual: null,
    totalOverride: null,
    varianceReasonCode: null,
    varianceReason: "",
    notes: "",
    payments: [],
    tip: 0,
    houseCourtesy: false,
    additionalServiceIds: [],
    applyPromo: true,
    firstVisit: false,
    clientRequestId: "req-1",
    ...over,
  };
}

function patchEscrito(): Record<string, unknown> {
  const update = writes.find((w) => w.what === "appointmentFinance.update");
  if (update === undefined) throw new Error("no se escribió la cuenta");
  return update.args[1] as Record<string, unknown>;
}

function renglonesEscritos(): unknown {
  return writes.find((w) => w.what === "appointmentFinanceItems.replaceForFinance")?.args[1];
}

beforeEach(() => {
  writes = [];
  existing = fila();
  session = { userId: "usr_lina", role: "staff", eaProviderId: LINA };
  // Miércoles: miércoles de pies.
  appointmentStart = "2026-10-14 10:00:00";
  historial = "primera";
  preguntasAlHistorial = 0;
});

describe("cerrarCuenta — la promo la calcula el servidor", () => {
  it("miércoles de pies: descuento, motivo `promo` y cuál fue", async () => {
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    expect(patchEscrito()).toMatchObject({
      discount: 15_000,
      amount_charged: 40_000,
      variance_reason_code: "promo",
      variance_reason: "miercoles-pies",
    });
    const audit = writes.find((w) => w.what === "auditLog.append");
    expect(audit?.args[0]).toMatchObject({
      reason: "promo",
      after: expect.objectContaining({
        promo: expect.objectContaining({ slug: "miercoles-pies", discount: 15_000, date: "2026-10-14" }),
      }),
    });
    // La del día no le pregunta nada al historial.
    expect(preguntasAlHistorial).toBe(0);
  });

  it("el día lo decide la cita en EA, no el navegador: un jueves no hay promo", async () => {
    appointmentStart = "2026-10-15 10:00:00";
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: true, amountCharged: 55_000 });
    expect(patchEscrito()).toMatchObject({ discount: 0, variance_reason_code: null });
  });

  it("un borrador de antes de las promos (sin el campo) se cobra a lista", async () => {
    const { applyPromo: _omitido, ...vieja } = entrada();
    void _omitido;
    expect(await cerrarCuenta(vieja)).toMatchObject({ ok: true, amountCharged: 55_000 });
  });

  it("quitada en la hoja, no se aplica", async () => {
    expect(await cerrarCuenta(entrada({ applyPromo: false }))).toMatchObject({
      ok: true,
      amountCharged: 55_000,
    });
  });

  it("el navegador no puede mandar `promo` como motivo", async () => {
    const result = await cerrarCuenta(
      entrada({ totalOverride: 10_000, varianceReasonCode: "promo" as never }),
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("con un método de pago, el pago es lo cobrado con promo", async () => {
    session = { userId: "usr_owner", role: "owner", eaProviderId: null };
    await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 55_000 }] }));
    const pagos = writes.find((w) => w.what === "appointmentPayments.replaceForFinance");
    expect(pagos?.args[1]).toEqual([{ method: "efectivo", amount: 40_000 }]);
  });
});

describe("cerrarCuenta — primera visita", () => {
  it("confirmada por el historial: `primera-visita` sin más", async () => {
    appointmentStart = "2026-10-15 10:00:00";
    const result = await cerrarCuenta(entrada({ performedServiceId: RUBBER, firstVisit: true }));
    expect(result).toMatchObject({ ok: true, amountCharged: 63_000 });
    expect(patchEscrito()).toMatchObject({
      discount: 7_000,
      variance_reason_code: "promo",
      variance_reason: "primera-visita",
    });
    expect(preguntasAlHistorial).toBe(1);
  });

  it("marcada a mano contra el historial: se respeta el cobro y queda dicho", async () => {
    appointmentStart = "2026-10-15 10:00:00";
    historial = "recurrente";
    const result = await cerrarCuenta(entrada({ performedServiceId: RUBBER, firstVisit: true }));
    // La técnica cobró con el 10 % que vio: el servidor no lo cambia.
    expect(result).toMatchObject({ ok: true, amountCharged: 63_000 });
    expect(patchEscrito().variance_reason).toBe(
      "primera-visita · marcada a mano: el historial dice que ya vino",
    );
  });

  it("sin la casilla, el servidor no pone el 10 % aunque el historial diga que es nueva", async () => {
    appointmentStart = "2026-10-15 10:00:00";
    const result = await cerrarCuenta(entrada({ performedServiceId: RUBBER, firstVisit: false }));
    expect(result).toMatchObject({ ok: true, amountCharged: 70_000 });
    expect(preguntasAlHistorial).toBe(0);
  });
});

describe("cerrarCuenta — total escrito, cortesía y segundo servicio", () => {
  it("un total escrito por debajo de la lista, con su motivo, se guarda", async () => {
    // Antes el motivo no le llegaba a `ticketFromEnteredTotal()` y esta cuenta
    // se rechazaba aunque la técnica lo hubiera elegido.
    appointmentStart = "2026-10-15 10:00:00";
    const result = await cerrarCuenta(
      entrada({ totalOverride: 50_000, varianceReasonCode: "correccion", varianceReason: "uña rota" }),
    );
    expect(result).toMatchObject({ ok: true, amountCharged: 50_000 });
    expect(patchEscrito()).toMatchObject({
      discount: 5_000,
      variance_reason_code: "correccion",
      variance_reason: "uña rota",
    });
  });

  it("y sin motivo se rechaza", async () => {
    appointmentStart = "2026-10-15 10:00:00";
    const result = await cerrarCuenta(entrada({ totalOverride: 50_000 }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("el total escrito igual al de la promo es la promo", async () => {
    const result = await cerrarCuenta(entrada({ totalOverride: 40_000 }));
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    expect(patchEscrito()).toMatchObject({ variance_reason_code: "promo", variance_reason: "miercoles-pies" });
  });

  it("la cortesía gana sobre la promo", async () => {
    session = { userId: "usr_owner", role: "owner", eaProviderId: null };
    const result = await cerrarCuenta(entrada({ houseCourtesy: true, firstVisit: true }));
    expect(result).toMatchObject({ ok: true, amountCharged: 0 });
    expect(patchEscrito()).toMatchObject({
      is_house_courtesy: 1,
      discount: 55_000,
      variance_reason_code: "cortesia",
      variance_reason: null,
    });
    expect(preguntasAlHistorial).toBe(0);
  });

  it("rubber + pies un miércoles: dos renglones de servicio y la promo en los pies", async () => {
    const result = await cerrarCuenta(
      entrada({ performedServiceId: RUBBER, additionalServiceIds: [SEMI_PIES] }),
    );
    expect(result).toMatchObject({ ok: true, amountCharged: 110_000 });
    expect(renglonesEscritos()).toEqual([
      expect.objectContaining({ kind: "servicio", ea_service_id: RUBBER, line_total: 70_000 }),
      expect.objectContaining({ kind: "servicio", ea_service_id: SEMI_PIES, line_total: 55_000 }),
    ]);
    expect(patchEscrito()).toMatchObject({
      performed_service_id: RUBBER,
      discount: 15_000,
      variance_reason_code: "promo",
    });
  });

  it("no acepta una lista de servicios agregados absurda", async () => {
    const result = await cerrarCuenta(
      entrada({ additionalServiceIds: [SEMI_PIES, SEMI_PIES, SEMI_PIES, SEMI_PIES, SEMI_PIES] }),
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });
});
