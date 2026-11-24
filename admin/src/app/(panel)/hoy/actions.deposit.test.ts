import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogService, TicketCatalog } from "@/components/ticket/catalog";
import type { CloseTicketInput, FirstVisitStatus } from "@/components/ticket/types";
import type { UserRole } from "@/db/types";

/**
 * La Server Action de cierre con **adelanto** (migración `034`), llamada
 * directamente.
 *
 * La frontera que importa: el adelanto lo lee el servidor de la base, no se lo
 * cree a la pantalla. Cubre lo que alcance como pago `abono`; el resto va con
 * el método de la hoja; uno mayor que la cuenta o en una cortesía se rechaza
 * sin escribir nada. Se dobla el borde —sesión, base, EA, catálogo— y la
 * decisión es la real.
 */

const LINA = 3;
const SEMI_PIES = 2;
const RUBBER = 1;
const DISENO = 10;

let session: { userId: string; role: UserRole; eaProviderId: number | null };
let existing: Record<string, unknown>;
let appointmentStart: string;
let historial: FirstVisitStatus;
let writes: { what: string; args: unknown[] }[];
let deposits: { amount: number; refunded_amount: number | null }[];

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
    appointmentDeposits: {
      listByAppointment: async () => deposits,
    },
    appointmentPayments: {
      listByFinanceId: async () => [],
      replaceForFinance: record("appointmentPayments.replaceForFinance"),
    },
    appointmentFinanceItems: {
      replaceForFinance: record("appointmentFinanceItems.replaceForFinance"),
    },
    auditLog: { append: record("auditLog.append") },
    commissionEntries: { listForFinance: async () => [] },
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
    pushed_to_ingest_at: null,
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

function pagosEscritos(): unknown {
  return writes.find((w) => w.what === "appointmentPayments.replaceForFinance")?.args[1];
}

beforeEach(() => {
  writes = [];
  existing = fila({ booked_service_id: RUBBER, service_price_snapshot: 70_000 });
  // La dueña cobra.
  session = { userId: "usr_owner", role: "owner", eaProviderId: null };
  // Jueves: sin promo del día.
  appointmentStart = "2026-10-15 10:00:00";
  historial = "recurrente";
  deposits = [{ amount: 30_000, refunded_amount: null }];
});

const rubber = (over: Partial<CloseTicketInput> = {}) =>
  entrada({ performedServiceId: RUBBER, applyPromo: false, ...over });

describe("cerrarCuenta — con adelanto", () => {
  it("cubre parte: un pago abono y el resto con el método de la hoja", async () => {
    const result = await cerrarCuenta(rubber({ payments: [{ method: "transferencia", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 70_000 });
    expect(pagosEscritos()).toEqual([
      { method: "abono", amount: 30_000 },
      { method: "transferencia", amount: 40_000 },
    ]);
    // Con dos pagos, el shim viejo no afirma un método.
    expect(patchEscrito()).toMatchObject({ amount_charged: 70_000, payment_method: null });
    const audit = writes.find((w) => w.what === "auditLog.append");
    expect(audit?.args[0]).toMatchObject({ after: expect.objectContaining({ deposit: 30_000 }) });
  });

  it("dos adelantos, uno devuelto en parte: se suma lo que queda", async () => {
    deposits = [
      { amount: 30_000, refunded_amount: null },
      { amount: 20_000, refunded_amount: 5_000 },
    ];
    await cerrarCuenta(rubber({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(pagosEscritos()).toEqual([
      { method: "abono", amount: 45_000 },
      { method: "efectivo", amount: 25_000 },
    ]);
  });

  it("cubre todo: un solo pago abono, y el shim viejo queda sin método", async () => {
    deposits = [{ amount: 70_000, refunded_amount: null }];
    const result = await cerrarCuenta(rubber());
    expect(result).toMatchObject({ ok: true });
    expect(pagosEscritos()).toEqual([{ method: "abono", amount: 70_000 }]);
    expect(patchEscrito()).toMatchObject({ payment_method: null });
  });

  it("con resto y sin método: se pide el método del resto, y no se escribe nada", async () => {
    const result = await cerrarCuenta(rubber());
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.message).toMatch(/El adelanto cubre \$\s?30\.000.*resto/);
    expect(writes).toEqual([]);
  });

  it("mayor que la cuenta: se rechaza con lo que hay que devolver, y no se escribe nada", async () => {
    deposits = [{ amount: 100_000, refunded_amount: null }];
    const result = await cerrarCuenta(rubber({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.message).toMatch(/devolución de \$\s?30\.000/);
    expect(writes).toEqual([]);
  });

  it("una cortesía con adelanto se rechaza: primero se devuelve", async () => {
    const result = await cerrarCuenta(rubber({ houseCourtesy: true }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.message).toMatch(/adelanto/);
    expect(writes).toEqual([]);
  });

  it("la técnica sin permiso de cobrar guarda sin pagos: el adelanto lo aplica recepción al cobrar", async () => {
    session = { userId: "usr_lina", role: "staff", eaProviderId: LINA };
    const result = await cerrarCuenta(rubber());
    expect(result).toMatchObject({ ok: true });
    expect(pagosEscritos()).toEqual([]);
    expect(patchEscrito()).toMatchObject({ paid_at: null });
  });

  it("sin adelanto, todo como siempre", async () => {
    deposits = [];
    await cerrarCuenta(rubber({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(pagosEscritos()).toEqual([{ method: "efectivo", amount: 70_000 }]);
    expect(patchEscrito()).toMatchObject({ payment_method: "efectivo" });
  });
});
