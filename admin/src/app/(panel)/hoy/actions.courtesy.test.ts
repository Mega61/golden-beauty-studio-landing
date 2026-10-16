import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogService, TicketCatalog } from "@/components/ticket/catalog";
import type { CloseTicketInput } from "@/components/ticket/types";
import type { UserRole } from "@/db/types";

/**
 * La Server Action de cierre, **llamada directamente**, con la cortesía de la
 * casa.
 *
 * La afirmación que importa es la de `auth-policy.ts`: "un botón escondido no
 * es un permiso". La hoja no le dibuja la casilla a la técnica, pero la Action
 * que hay detrás se puede invocar sin la hoja —con un `fetch` armado a mano—, y
 * es ahí donde la técnica no puede regalar un servicio que le paga comisión.
 *
 * Se dobla el borde y nada más: la sesión, la base, EA y el catálogo. La
 * decisión —el permiso, la cuenta de `lib/ticket.ts`, el parche que se
 * escribe— es la real.
 */

// ── Dobles ──────────────────────────────────────────────────────────────────

const LINA = 3;
const FORRADO = 5;
const DISENO = 31;

let session: { userId: string; role: UserRole; eaProviderId: number | null };
let existing: Record<string, unknown>;

/** Lo que la Action intentó escribir, en orden. */
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
    appointments: { get: async (id: number) => ({ id, providerId: LINA, serviceId: FORRADO }) },
  }),
}));

vi.mock("@/jobs/snapshot", () => ({
  upsertAppointmentFinance: async () => ({ financeId: 91 }),
}));

function servicio(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Montajes",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    servicio({ eaServiceId: FORRADO, name: "Forrado", listPrice: 85_000 }),
    servicio({ eaServiceId: DISENO, name: "Diseño por uña", listPrice: 10_000, isExtra: true }),
  ],
};

vi.mock("./catalog-server", () => ({ loadCatalogForClose: async () => CATALOGO }));

const { cerrarCuenta } = await import("./actions");

// ── Fixtures ────────────────────────────────────────────────────────────────

function fila(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 91,
    ea_appointment_id: 7001,
    booked_service_id: FORRADO,
    // El precio congelado al agendar: manda sobre el de hoy (85.000).
    service_price_snapshot: 180_000,
    performed_service_id: null,
    discount: 0,
    tip: 0,
    amount_charged: null,
    is_house_courtesy: 0,
    appointment_start_at: new Date("2026-09-08T14:00:00Z"),
    closed_at: null,
    day_close_id: null,
    ...over,
  };
}

function entrada(over: Partial<CloseTicketInput> = {}): CloseTicketInput {
  return {
    eaAppointmentId: 7001,
    performedServiceId: FORRADO,
    extras: { [String(DISENO)]: 3 },
    manual: null,
    totalOverride: null,
    varianceReasonCode: null,
    varianceReason: "",
    notes: "",
    payments: [],
    tip: 0,
    houseCourtesy: true,
    clientRequestId: "req-1",
    ...over,
  };
}

const DUENA = { userId: "usr_owner", role: "owner" as const, eaProviderId: null };
const TECNICA = { userId: "usr_lina", role: "staff" as const, eaProviderId: LINA };
const RECEPCION = { userId: "usr_recepcion", role: "admin" as const, eaProviderId: null };

function patchEscrito(): Record<string, unknown> {
  const update = writes.find((w) => w.what === "appointmentFinance.update");
  if (update === undefined) throw new Error("no se escribió la cuenta");
  return update.args[1] as Record<string, unknown>;
}

beforeEach(() => {
  writes = [];
  existing = fila();
  session = DUENA;
});

// ── El permiso ──────────────────────────────────────────────────────────────

describe("cerrarCuenta — quién puede marcar una cortesía", () => {
  it("la técnica no puede, ni llamando la Action sin la hoja, y no se escribe nada", async () => {
    session = TECNICA;
    const result = await cerrarCuenta(entrada());
    expect(result).toEqual({
      ok: false,
      retryable: false,
      message: "Solo la dueña puede cerrar una cuenta como cortesía de la casa.",
    });
    expect(writes).toEqual([]);
  });

  it("recepción tampoco", async () => {
    session = RECEPCION;
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("la técnica no puede quitarle la marca a una cortesía que ya existe", async () => {
    // Desmarcarla también es decidir sobre ella: dejaría cobrando a alguien a
    // quien la dueña decidió no cobrarle.
    session = TECNICA;
    existing = fila({ is_house_courtesy: 1, closed_at: new Date(), amount_charged: 0 });
    const result = await cerrarCuenta(entrada({ houseCourtesy: false }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok ? "" : result.message).toMatch(/Solo la dueña la puede cambiar/);
    expect(writes).toEqual([]);
  });

  it("ni editarle los adicionales manteniéndola: le pagaría comisión sobre lo que nadie cobró", async () => {
    session = TECNICA;
    existing = fila({ is_house_courtesy: 1, closed_at: new Date(), amount_charged: 0 });
    expect(await cerrarCuenta(entrada({ extras: { [String(DISENO)]: 10 } }))).toMatchObject({
      ok: false,
    });
    expect(writes).toEqual([]);
  });

  it("la técnica sí cierra una cuenta normal de la misma clienta", async () => {
    session = TECNICA;
    const result = await cerrarCuenta(entrada({ houseCourtesy: false }));
    expect(result).toMatchObject({ ok: true, amountCharged: 210_000 });
    expect(patchEscrito()).toMatchObject({ is_house_courtesy: 0, amount_charged: 210_000 });
  });

  it("un borrador viejo sin el campo se cierra como cuenta cobrada", async () => {
    session = TECNICA;
    const { houseCourtesy: _omitido, ...vieja } = entrada();
    void _omitido;
    expect(await cerrarCuenta(vieja)).toMatchObject({ ok: true, amountCharged: 210_000 });
  });
});

// ── Lo que se escribe ───────────────────────────────────────────────────────

describe("cerrarCuenta — la cortesía de la dueña", () => {
  it("cobra cero, guarda los renglones a precio de lista y deja la marca", async () => {
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: true, amountCharged: 0, tip: 0 });

    expect(patchEscrito()).toMatchObject({
      is_house_courtesy: 1,
      amount_charged: 0,
      // El descuento es la lista entera: 180.000 congelados + 3 × 10.000.
      discount: 210_000,
      tip: 0,
      payment_method: null,
      paid_at: null,
      variance_reason_code: "cortesia",
      variance_reason: null,
    });

    const items = writes.find((w) => w.what === "appointmentFinanceItems.replaceForFinance");
    expect(items?.args[1]).toEqual([
      expect.objectContaining({ kind: "servicio", unit_price_snapshot: 180_000, line_total: 180_000 }),
      expect.objectContaining({ kind: "adicional", qty: 3, unit_price_snapshot: 10_000, line_total: 30_000 }),
    ]);

    // Ningún pago: la cortesía no entra a la caja.
    const pagos = writes.find((w) => w.what === "appointmentPayments.replaceForFinance");
    expect(pagos?.args[1]).toEqual([]);
  });

  it("deja la bitácora con el antes y el después, como cualquier cierre", async () => {
    await cerrarCuenta(entrada());
    const audit = writes.find((w) => w.what === "auditLog.append");
    expect(audit?.args[0]).toMatchObject({
      actorUserId: DUENA.userId,
      action: "ticket.close",
      entity: "appointment_finance",
      entityId: 91,
      reason: "cortesia",
      before: expect.objectContaining({ is_house_courtesy: 0 }),
      after: expect.objectContaining({ is_house_courtesy: 1, amount_charged: 0 }),
    });
  });

  it("rechaza la propina en vez de descartarla", async () => {
    const result = await cerrarCuenta(entrada({ tip: 20_000 }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("rechaza un método de pago", async () => {
    const result = await cerrarCuenta(
      entrada({ payments: [{ method: "efectivo", amount: 210_000 }] }),
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("ignora un total escrito a mano: la cortesía es cero, no lo que diga el campo", async () => {
    const result = await cerrarCuenta(entrada({ totalOverride: 50_000 }));
    expect(result).toMatchObject({ ok: true, amountCharged: 0 });
  });

  it("la dueña puede desmarcarla y cobrarla: a veces pagan", async () => {
    existing = fila({ is_house_courtesy: 1, closed_at: new Date(), amount_charged: 0, discount: 210_000 });
    const result = await cerrarCuenta(entrada({ houseCourtesy: false }));
    expect(result).toMatchObject({ ok: true, amountCharged: 210_000 });
    expect(patchEscrito()).toMatchObject({
      is_house_courtesy: 0,
      amount_charged: 210_000,
      discount: 0,
      variance_reason_code: null,
    });
    const audit = writes.find((w) => w.what === "auditLog.append");
    expect(audit?.args[0]).toMatchObject({ action: "ticket.update" });
  });

  it("después del cierre del día no se toca, ni siquiera para la dueña", async () => {
    existing = fila({ day_close_id: 12, closed_at: new Date(), amount_charged: 210_000 });
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });
});
