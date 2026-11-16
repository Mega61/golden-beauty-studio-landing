import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogService, TicketCatalog } from "@/components/ticket/catalog";
import type { CloseTicketInput, FirstVisitStatus } from "@/components/ticket/types";
import type { UserRole } from "@/db/types";
import type { GiftCardDto } from "@/lib/stampee/client";

/**
 * `cerrarCuenta()` con **tarjeta regalo**, llamada directamente.
 *
 * La hoja manda solo el código; el servidor lee la tarjeta de Stampee, decide
 * si es pago o descuento, la redime **antes** de escribir y la deshace si la
 * escritura falla. Se dobla el borde (sesión, base, EA, Stampee) y la decisión
 * es la real.
 *
 * Miércoles 2026-10-14: semipermanente pies 55.000 → miércoles de pies 40.000.
 */

const LINA = 3;
const SEMI_PIES = 2;
const CODE = "TR-AB12-CD34";

let session: { userId: string; role: UserRole; eaProviderId: number | null };
let existing: Record<string, unknown>;
let existingPayments: { method: string; amount: number }[];
let historial: FirstVisitStatus;
let writes: { what: string; args: unknown[] }[];
let stampee: { what: string; args: unknown[] }[];
let card: GiftCardDto | null;
let redeemOutcome:
  | { ok: true; card: GiftCardDto; alreadyRedeemed: boolean }
  | { ok: false; status: number | null; code: string | null; message: string; conflict: boolean };
let unredeemOutcome: { ok: true } | { ok: false; status: number | null; code: string | null; message: string };
let failWrite: boolean;

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
      update: async (...args: unknown[]) => {
        if (failWrite) throw new Error("la base se cayó");
        writes.push({ what: "appointmentFinance.update", args });
      },
    },
    appointmentPayments: {
      listByFinanceId: async () => existingPayments,
      replaceForFinance: record("appointmentPayments.replaceForFinance"),
    },
    appointmentFinanceItems: {
      replaceForFinance: record("appointmentFinanceItems.replaceForFinance"),
    },
    auditLog: { append: record("auditLog.append"), listForEntity: async () => [] },
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
        start: "2026-10-14 10:00:00",
        status: "Completada",
      }),
      update: async () => ({}),
    },
    customers: {
      get: async () => ({ firstName: "Lucía", lastName: "Gómez", phone: "3001234567" }),
    },
  }),
  createCachedEaClient: () => ({}),
}));

vi.mock("@/jobs/snapshot", () => ({
  upsertAppointmentFinance: async () => ({ financeId: 91 }),
}));

vi.mock("./first-visit", () => ({ detectFirstVisit: async () => historial }));

vi.mock("@/lib/stampee/client", () => ({
  getGiftCardByCode: async (code: string) => {
    stampee.push({ what: "get", args: [code] });
    return card;
  },
  redeemGiftCard: async (code: string, input: unknown) => {
    stampee.push({ what: "redeem", args: [code, input] });
    return redeemOutcome;
  },
  unredeemGiftCard: async (code: string, input: unknown) => {
    stampee.push({ what: "unredeem", args: [code, input] });
    return unredeemOutcome;
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
    servicio({ eaServiceId: SEMI_PIES, name: "Semipermanente pies", listPrice: 55_000, pricingId: "semi-permanent-feet" }),
  ],
};

vi.mock("./catalog-server", () => ({ loadCatalogForClose: async () => CATALOGO }));

const { cerrarCuenta, consultarTarjetaRegalo } = await import("./actions");

function tarjeta(over: Partial<GiftCardDto> = {}): GiftCardDto {
  return {
    id: "gc-1",
    uniqueId: "u-1",
    code: CODE,
    amountCop: 100_000,
    status: "active",
    effectiveStatus: "active",
    funded: true,
    source: "sale",
    tierId: "t-1",
    tierName: "Consentida",
    buyerCustomerId: null,
    buyerName: "Ana",
    buyerPhone: "+573001112233",
    recipientName: "Lucía",
    recipientPhone: null,
    recipientCustomerId: null,
    message: "",
    validFrom: "2026-10-01",
    validTo: "2027-10-01",
    minTicketCop: null,
    transferable: true,
    rules: {},
    paidAt: null,
    paidMethod: null,
    paidAmountCop: null,
    paidRef: null,
    redeemedAt: null,
    redeemedRef: null,
    redeemedAmountCop: null,
    voidedAt: null,
    voidReason: null,
    externalRef: null,
    publicUrl: null,
    createdAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

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
    gift_card_code: null,
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
    giftCardCode: CODE,
    clientRequestId: "req-1",
    ...over,
  };
}

const patchEscrito = () =>
  writes.find((w) => w.what === "appointmentFinance.update")?.args[1] as Record<string, unknown> | undefined;
const pagosEscritos = () => writes.find((w) => w.what === "appointmentPayments.replaceForFinance")?.args[1];

beforeEach(() => {
  writes = [];
  stampee = [];
  existing = fila();
  existingPayments = [];
  historial = "primera";
  session = { userId: "usr_recepcion", role: "admin", eaProviderId: null };
  card = tarjeta();
  redeemOutcome = { ok: true, card: tarjeta({ status: "redeemed" }), alreadyRedeemed: false };
  unredeemOutcome = { ok: true };
  failWrite = false;
});

describe("cerrarCuenta — tarjeta pagada", () => {
  it("es un pago bono por lo que cubre, redimido antes de escribir", async () => {
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    // La comisión no cambia: lo cobrado sigue siendo 40.000 con la promo.
    expect(patchEscrito()).toMatchObject({ amount_charged: 40_000, gift_card_code: CODE, payment_method: null });
    expect(pagosEscritos()).toEqual([{ method: "bono", amount: 40_000, gift_card_code: CODE }]);
    expect(stampee.map((s) => s.what)).toEqual(["get", "redeem"]);
    expect(stampee[1].args[1]).toMatchObject({
      externalRef: "ea-appt:7001",
      amountUsedCop: 40_000,
      date: "2026-10-14",
      customer: { name: "Lucía Gómez", phone: "3001234567" },
    });
  });

  it("paga toda la cuenta y hay propina: se exige su método y se guarda aparte", async () => {
    expect(await cerrarCuenta(entrada({ tip: 5_000 }))).toMatchObject({
      ok: false,
      retryable: false,
      message: expect.stringContaining("propina"),
    });
    expect(stampee.map((s) => s.what)).toEqual(["get"]);
    expect(writes).toEqual([]);

    stampee = [];
    const result = await cerrarCuenta(entrada({ tip: 5_000, payments: [{ method: "transferencia", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000, tip: 5_000 });
    expect(pagosEscritos()).toEqual([{ method: "bono", amount: 40_000, gift_card_code: CODE }]);
    expect(patchEscrito()).toMatchObject({ tip: 5_000, tip_method: "transferencia" });
  });

  it("con otro pago, la propina va en él y no hay método aparte", async () => {
    card = tarjeta({ amountCop: 30_000 });
    await cerrarCuenta(entrada({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }));
    expect(patchEscrito()).toMatchObject({ tip: 5_000, tip_method: null });
  });

  it("si no alcanza, el resto va con el método de la hoja", async () => {
    card = tarjeta({ amountCop: 30_000 });
    const result = await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    expect(pagosEscritos()).toEqual([
      { method: "bono", amount: 30_000, gift_card_code: CODE },
      { method: "efectivo", amount: 10_000 },
    ]);
  });

  it("si no alcanza y no hay método para el resto, se pide", async () => {
    card = tarjeta({ amountCop: 30_000 });
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: false, retryable: false, message: expect.stringContaining("el resto") });
    expect(stampee.map((s) => s.what)).toEqual(["get"]);
    expect(writes).toEqual([]);
  });

  it("registrarla es cobrar: la técnica sin TICKET_STAFF_COBRA no puede", async () => {
    session = { userId: "usr_lina", role: "staff", eaProviderId: LINA };
    const result = await cerrarCuenta(entrada());
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("recepción") });
    expect(stampee.map((s) => s.what)).toEqual(["get"]);
  });

  it("usada en otra visita: se rechaza sin escribir", async () => {
    card = tarjeta({ status: "redeemed", redeemedRef: "ea-appt:1" });
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, retryable: false });
    expect(writes).toEqual([]);
  });

  it("Stampee dice que otra cuenta la usó (409) entre leer y redimir: rechazo, nada escrito", async () => {
    redeemOutcome = { ok: false, status: 409, code: "ALREADY_REDEEMED", message: "x", conflict: true };
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, retryable: false, message: expect.stringContaining("ya se usó") });
    expect(writes).toEqual([]);
  });

  it.each([
    ["NOT_PAID", 409, "todavía no está pagada"],
    ["VOID", 409, "anulada"],
    ["EXPIRED", 409, "venció"],
    ["NOT_YET_VALID", 409, "todavía no vale"],
    ["VALIDATION", 400, "más de lo que vale"],
  ])("Stampee dice %s: rechazo definitivo con su texto en español", async (code, status, texto) => {
    redeemOutcome = { ok: false, status, code, message: "x", conflict: false };
    expect(await cerrarCuenta(entrada())).toMatchObject({
      ok: false,
      retryable: false,
      message: expect.stringContaining(texto),
    });
    expect(writes).toEqual([]);
  });

  it("Stampee caído: se reintenta, nada escrito", async () => {
    redeemOutcome = { ok: false, status: null, code: null, message: "Stampee no respondió", conflict: false };
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, retryable: true });
    expect(writes).toEqual([]);
  });

  it("si la escritura falla, la redención se deshace", async () => {
    failWrite = true;
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, retryable: true });
    expect(stampee.map((s) => s.what)).toEqual(["get", "redeem", "unredeem"]);
  });

  it("volver a guardar la misma cuenta no la redime otra vez", async () => {
    existing = fila({ closed_at: new Date(), gift_card_code: CODE, amount_charged: 40_000 });
    existingPayments = [{ method: "bono", amount: 40_000 }];
    card = tarjeta({ status: "redeemed", redeemedRef: "ea-appt:7001" });
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: true });
    expect(stampee.map((s) => s.what)).toEqual(["get"]);
  });
});

describe("cerrarCuenta — tarjeta promocional", () => {
  it("descuenta más que la promo: es el descuento, con motivo `promo` y el código", async () => {
    card = tarjeta({ funded: false, source: "advent", amountCop: 20_000 });
    const result = await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 35_000 });
    expect(patchEscrito()).toMatchObject({
      discount: 20_000,
      variance_reason_code: "promo",
      variance_reason: `bono ${CODE}`,
      gift_card_code: CODE,
    });
    expect(pagosEscritos()).toEqual([{ method: "efectivo", amount: 35_000 }]);
    expect(stampee[1]).toMatchObject({ what: "redeem", args: [CODE, expect.objectContaining({ amountUsedCop: 20_000 })] });
  });

  it("la promo descuenta más: gana la promo y la tarjeta no se redime", async () => {
    card = tarjeta({ funded: false, amountCop: 10_000 });
    const result = await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    expect(patchEscrito()).toMatchObject({ variance_reason: "miercoles-pies", gift_card_code: null });
    expect(stampee.map((s) => s.what)).toEqual(["get"]);
  });

  it("solo para nuevas, con una clienta que ya vino: rechazada", async () => {
    card = tarjeta({ funded: false, amountCop: 20_000, rules: { recipient: "new_or_dormant" } });
    historial = "recurrente";
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: false, message: expect.stringContaining("nuevas") });
    historial = "recuperacion";
    expect(await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 0 }] }))).toMatchObject({ ok: true });
  });

  it("la técnica sí puede aplicarla: es un descuento, no un cobro", async () => {
    session = { userId: "usr_lina", role: "staff", eaProviderId: LINA };
    card = tarjeta({ funded: false, amountCop: 20_000 });
    expect(await cerrarCuenta(entrada())).toMatchObject({ ok: true, amountCharged: 35_000 });
  });
});

describe("cerrarCuenta — quitar la tarjeta", () => {
  it("una cuenta que tenía tarjeta y se guarda sin ella la libera en Stampee", async () => {
    existing = fila({ closed_at: new Date(), gift_card_code: CODE, amount_charged: 40_000 });
    existingPayments = [{ method: "bono", amount: 40_000 }];
    const result = await cerrarCuenta(entrada({ giftCardCode: null, payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true });
    expect(stampee).toEqual([{ what: "unredeem", args: [CODE, { externalRef: "ea-appt:7001" }] }]);
    expect(patchEscrito()).toMatchObject({ gift_card_code: null });
  });

  it("si la escritura falla después de liberarla, se vuelve a redimir", async () => {
    existing = fila({ closed_at: new Date(), gift_card_code: CODE, amount_charged: 40_000 });
    existingPayments = [{ method: "bono", amount: 40_000 }];
    failWrite = true;
    await cerrarCuenta(entrada({ giftCardCode: null, payments: [{ method: "efectivo", amount: 0 }] }));
    expect(stampee.map((s) => s.what)).toEqual(["unredeem", "redeem"]);
    expect(stampee[1].args[1]).toMatchObject({ externalRef: "ea-appt:7001", amountUsedCop: 40_000 });
  });

  it("REF_MISMATCH al liberar: la tiene otra cuenta, esta se guarda sin ella y no se re-redime", async () => {
    existing = fila({ closed_at: new Date(), gift_card_code: CODE, amount_charged: 40_000 });
    existingPayments = [{ method: "bono", amount: 40_000 }];
    unredeemOutcome = { ok: false, status: 409, code: "REF_MISMATCH", message: "x" };
    expect(await cerrarCuenta(entrada({ giftCardCode: null, payments: [{ method: "efectivo", amount: 0 }] }))).toMatchObject({ ok: true });
    expect(patchEscrito()).toMatchObject({ gift_card_code: null });
  });

  it.each([
    [{ ok: false as const, status: 409, code: "NOT_REDEEMED", message: "x" }],
    [{ ok: false as const, status: 404, code: "NOT_FOUND", message: "x" }],
    [{ ok: false as const, status: null, code: null, message: "x" }],
  ])("cualquier otra respuesta al liberar: no se adivina, se reintenta sin escribir (%o)", async (outcome) => {
    existing = fila({ closed_at: new Date(), gift_card_code: CODE, amount_charged: 40_000 });
    existingPayments = [{ method: "bono", amount: 40_000 }];
    unredeemOutcome = outcome;
    expect(await cerrarCuenta(entrada({ giftCardCode: null, payments: [{ method: "efectivo", amount: 0 }] }))).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(writes).toEqual([]);
  });

  it("un código inválido se rechaza antes de todo", async () => {
    expect(await cerrarCuenta(entrada({ giftCardCode: "hola" }))).toMatchObject({ ok: false, retryable: false });
    expect(stampee).toEqual([]);
  });
});

describe("cerrarCuenta — una cuenta ya en Actual", () => {
  it("el ajuste se mide sobre lo que viajó, no sobre lo que pagó la tarjeta", async () => {
    session = { userId: "usr_owner", role: "owner", eaProviderId: null };
    // Viajó 40.000 en efectivo. Ahora la clienta trae su tarjeta de 30.000.
    existing = fila({ closed_at: new Date(), amount_charged: 40_000, pushed_to_ingest_at: new Date(), day_close_id: 5 });
    existingPayments = [{ method: "efectivo", amount: 40_000 }];
    card = tarjeta({ amountCop: 30_000 });
    const result = await cerrarCuenta(entrada({ payments: [{ method: "efectivo", amount: 0 }] }));
    expect(result).toMatchObject({ ok: true, amountCharged: 40_000 });
    const ajuste = writes.find(
      (w) => w.what === "auditLog.append" && (w.args[0] as { action: string }).action === "ticket.adjust",
    );
    expect(ajuste?.args[0]).toMatchObject({ after: expect.objectContaining({ delta: -30_000 }) });
  });
});

describe("consultarTarjetaRegalo", () => {
  it("devuelve la tarjeta lista para la hoja", async () => {
    expect(await consultarTarjetaRegalo(7001, "tr ab12 cd34")).toMatchObject({
      ok: true,
      quote: { code: CODE, amountCop: 100_000, funded: true },
    });
  });

  it("no existe / código malo / pagada para quien no cobra", async () => {
    card = null;
    expect(await consultarTarjetaRegalo(7001, CODE)).toMatchObject({ ok: false, message: expect.stringContaining("No hay") });
    expect(await consultarTarjetaRegalo(7001, "xx")).toMatchObject({ ok: false });
    card = tarjeta();
    session = { userId: "usr_lina", role: "staff", eaProviderId: LINA };
    expect(await consultarTarjetaRegalo(7001, CODE)).toMatchObject({ ok: false, message: expect.stringContaining("recepción") });
  });
});
