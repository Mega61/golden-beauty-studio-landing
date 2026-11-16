import { describe, expect, it } from "vitest";

import {
  ADVENT_RECENT_HOURS,
  adventErrorMessage,
  adventForCustomers,
  adventFrontDesk,
  adventKindNote,
  adventStatus,
  adventTicketNote,
  adventValidity,
  availableCouponCount,
  canMarkUsed,
  canUndo,
  shortDay,
  type StudioAdventReward,
} from "./advent";

const TODAY = "2026-12-05";

function reward(over: Partial<StudioAdventReward> = {}): StudioAdventReward {
  return {
    id: "r-1",
    doorNo: 2,
    dayLabel: 4,
    kind: "coupon",
    title: "Retiro gratis",
    subtitle: "En tu próxima cita",
    terms: ["Válido en manos o pies."],
    code: "GB-AB12",
    status: "available",
    validFrom: "2026-12-04",
    validTo: "2026-12-10",
    openedAt: "2026-12-04T14:00:00.000Z",
    url: null,
    stamps: null,
    giftCardId: null,
    customerId: "c-1",
    customerName: "Laura",
    redeemedAt: null,
    redeemedBy: null,
    ...over,
  };
}

describe("canMarkUsed / canUndo", () => {
  it("un cupón disponible y vigente se marca usado", () => {
    expect(canMarkUsed(reward(), TODAY)).toBe(true);
    expect(canMarkUsed(reward({ validFrom: null }), TODAY)).toBe(true);
    expect(canMarkUsed(reward({ validFrom: TODAY }), TODAY)).toBe(true);
  });

  it("no antes de su fecha, ni usado, ni vencido, ni lo que no es cupón", () => {
    expect(canMarkUsed(reward({ validFrom: "2026-12-06" }), TODAY)).toBe(false);
    expect(canMarkUsed(reward({ status: "redeemed" }), TODAY)).toBe(false);
    expect(canMarkUsed(reward({ status: "expired" }), TODAY)).toBe(false);
    expect(canMarkUsed(reward({ kind: "bonus_stamps", code: null }), TODAY)).toBe(false);
    expect(canMarkUsed(reward({ code: null }), TODAY)).toBe(false);
  });

  it("solo se deshace un cupón usado", () => {
    expect(canUndo(reward({ status: "redeemed" }))).toBe(true);
    expect(canUndo(reward())).toBe(false);
    expect(canUndo(reward({ status: "redeemed", kind: "gift_card", code: null }))).toBe(false);
  });
});

describe("textos", () => {
  it("la nota de la cuenta dice el día de la puerta", () => {
    expect(adventTicketNote({ dayLabel: 8 })).toBe("Adviento día 8");
  });

  it("los días se leen sin zona horaria: es un día de calendario", () => {
    expect(shortDay("2026-12-04")).toBe("4 dic");
    expect(shortDay("2027-01-31")).toBe("31 ene");
  });

  it("la vigencia en una línea", () => {
    expect(adventValidity({ validFrom: "2026-12-04", validTo: "2026-12-10" })).toBe("Vale del 4 dic al 10 dic");
    expect(adventValidity({ validFrom: null, validTo: "2026-12-10" })).toBe("Vale hasta el 10 dic");
    expect(adventValidity({ validFrom: "2026-12-04", validTo: null })).toBe("Vale desde el 4 dic");
    expect(adventValidity({ validFrom: null, validTo: null })).toBe("Sin fecha de vencimiento");
  });

  it("el estado como lo lee la recepción", () => {
    expect(adventStatus(reward(), TODAY)).toEqual({ label: "Por usar", tone: "ok" });
    expect(adventStatus(reward({ kind: "link", code: null }), TODAY)).toEqual({ label: "Disponible", tone: "ok" });
    expect(adventStatus(reward({ validFrom: "2026-12-08" }), TODAY)).toEqual({ label: "Desde el 8 dic", tone: "warn" });
    expect(adventStatus(reward({ status: "redeemed" }), TODAY).label).toBe("Usado");
    expect(adventStatus(reward({ status: "expired" }), TODAY).label).toBe("Vencido");
    expect(adventStatus(reward({ status: "transferred" }), TODAY).label).toBe("Regalado a otra persona");
  });

  it("los regalos que no son cupón dicen por qué no se marcan", () => {
    expect(adventKindNote("coupon")).toBeNull();
    for (const kind of ["bonus_stamps", "double_stamps", "link", "gift_card"] as const) {
      expect(adventKindNote(kind)).toEqual(expect.any(String));
    }
  });
});

describe("adventForCustomers", () => {
  it("solo los de sus fichas, sin vencidos ni regalados, cupones vigentes primero", () => {
    const rows = [
      reward({ id: "otra", customerId: "c-9" }),
      reward({ id: "vencido", status: "expired" }),
      reward({ id: "regalado", status: "transferred" }),
      reward({ id: "sellos", kind: "bonus_stamps", code: null, validTo: "2026-12-06" }),
      reward({ id: "usado-viejo", status: "redeemed", redeemedAt: "2026-12-04T10:00:00Z" }),
      reward({ id: "usado-nuevo", status: "redeemed", redeemedAt: "2026-12-05T10:00:00Z" }),
      reward({ id: "futuro", validFrom: "2026-12-08", validTo: "2026-12-12" }),
      reward({ id: "tarde", validTo: "2026-12-20" }),
      reward({ id: "pronto", validTo: "2026-12-07" }),
      reward({ id: "otra-ficha", customerId: "c-2", validTo: "2026-12-09" }),
    ];
    expect(adventForCustomers(rows, ["c-1", "c-2"], TODAY).map((r) => r.id)).toEqual([
      "pronto",
      "otra-ficha",
      "tarde",
      "sellos",
      "futuro",
      "usado-nuevo",
      "usado-viejo",
    ]);
  });

  it("los usados que no son cupón no se muestran: no hay nada que deshacer", () => {
    expect(adventForCustomers([reward({ kind: "link", code: null, status: "redeemed" })], ["c-1"], TODAY)).toEqual([]);
  });
});

describe("availableCouponCount", () => {
  it("cuenta solo cupones por usar de sus fichas", () => {
    const rows = [
      reward(),
      reward({ id: "b", customerId: "c-2" }),
      reward({ id: "c", status: "redeemed" }),
      reward({ id: "d", kind: "bonus_stamps", code: null }),
      reward({ id: "e", customerId: "c-9" }),
    ];
    expect(availableCouponCount(rows, ["c-1", "c-2"])).toBe(2);
    expect(availableCouponCount(rows, [])).toBe(0);
  });
});

describe("adventFrontDesk", () => {
  const now = new Date("2026-12-05T20:00:00Z");

  it("los cupones por usar (el que vence antes arriba) y los usados recientes para deshacer", () => {
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const older = new Date(now.getTime() - (ADVENT_RECENT_HOURS + 1) * 60 * 60 * 1000).toISOString();
    const rows = [
      reward({ id: "b", customerName: "Sofía", validTo: "2026-12-10" }),
      reward({ id: "a", customerName: "Ana", validTo: "2026-12-10" }),
      reward({ id: "z", customerName: "Zoe", validTo: "2026-12-06" }),
      reward({ id: "sellos", kind: "bonus_stamps", code: null }),
      reward({ id: "usado", status: "redeemed", redeemedAt: recent }),
      reward({ id: "usado-viejo", status: "redeemed", redeemedAt: older }),
      reward({ id: "usado-sin-fecha", status: "redeemed", redeemedAt: null }),
    ];
    const { available, recentlyUsed } = adventFrontDesk(rows, now);
    expect(available.map((r) => r.id)).toEqual(["z", "a", "b"]);
    expect(recentlyUsed.map((r) => r.id)).toEqual(["usado"]);
  });
});

describe("adventErrorMessage", () => {
  it("cada 409 del contrato tiene su frase", () => {
    expect(adventErrorMessage("EXPIRED", 409, "x")).toMatch(/venció/);
    expect(adventErrorMessage("NOT_YET_VALID", 409, "x")).toMatch(/todavía no está vigente/);
    expect(adventErrorMessage("NOT_REDEEMABLE", 409, "x")).toMatch(/no es un cupón/);
  });

  it("404, llave mala, Stampee caído y lo demás", () => {
    expect(adventErrorMessage("NOT_FOUND", 404, "x")).toMatch(/no existe/);
    expect(adventErrorMessage(null, 401, "x")).toMatch(/STAMPEE_API_KEY/);
    expect(adventErrorMessage(null, null, "x")).toMatch(/no respondió/);
    expect(adventErrorMessage("BOOM", 500, "genérico")).toBe("genérico");
  });
});
