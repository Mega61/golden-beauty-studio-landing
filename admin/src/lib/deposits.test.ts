import { describe, expect, it } from "vitest";

import {
  addBlockReason,
  availableDeposit,
  depositExcess,
  depositPaidAt,
  depositPayment,
  depositRemaining,
  depositServiceName,
  depositState,
  moveBlockReason,
  refundBlockReason,
} from "./deposits";

/**
 * Las reglas de los adelantos. La que más cuesta si se rompe: un adelanto
 * **nunca** cubre más que la cuenta en silencio — la diferencia es plata de la
 * clienta que ya está en Actual.
 */

const dep = (amount: number, refunded: number | null = null) => ({ amount, refunded_amount: refunded });

describe("lo que queda de un adelanto", () => {
  it("sin devolución, todo; con devolución parcial, la diferencia; devuelto entero, cero", () => {
    expect(depositRemaining(dep(50_000))).toBe(50_000);
    expect(depositRemaining(dep(50_000, 20_000))).toBe(30_000);
    expect(depositRemaining(dep(50_000, 50_000))).toBe(0);
  });

  it("una cita con dos adelantos suma los dos", () => {
    expect(availableDeposit([dep(30_000), dep(70_000, 10_000)])).toBe(90_000);
    expect(availableDeposit([])).toBe(0);
  });
});

describe("lo que el adelanto cubre de la cuenta", () => {
  it("cubre lo que alcance", () => {
    expect(depositPayment(50_000, 150_000)).toBe(50_000);
    expect(depositPayment(150_000, 150_000)).toBe(150_000);
  });

  it("nunca más que la cuenta, y lo que sobra se dice", () => {
    expect(depositPayment(200_000, 150_000)).toBe(150_000);
    expect(depositExcess(200_000, 150_000)).toBe(50_000);
    expect(depositExcess(50_000, 150_000)).toBe(0);
  });

  it("una cuenta en cero (o negativa por error) no se paga con nada", () => {
    expect(depositPayment(50_000, 0)).toBe(0);
    expect(depositPayment(50_000, -10)).toBe(0);
    expect(depositPayment(-5, 100)).toBe(0);
    expect(depositExcess(50_000, -10)).toBe(50_000);
  });
});

describe("el día del pago", () => {
  const ahora = new Date("2026-11-23T20:00:00Z"); // 3 p. m. en Bogotá

  it("hoy es ahora; un día pasado es su mediodía en Bogotá; uno futuro no se acepta", () => {
    expect(depositPaidAt("2026-11-23", ahora)).toBe(ahora);
    expect(depositPaidAt("2026-11-20", ahora)?.toISOString()).toBe("2026-11-20T17:00:00.000Z");
    expect(depositPaidAt("2026-11-24", ahora)).toBeNull();
  });
});

describe("el estado", () => {
  it("devuelto entero gana; si no, la cuenta cerrada lo deja usado", () => {
    expect(depositState(dep(50_000, 50_000), true)).toBe("devuelto");
    expect(depositState(dep(50_000, 10_000), true)).toBe("aplicado");
    expect(depositState(dep(50_000), false)).toBe("pendiente");
  });

  it("el rótulo de Actual dice de qué cita es, si se sabe", () => {
    expect(depositServiceName("2026-12-12")).toBe("Adelanto cita 2026-12-12");
    expect(depositServiceName(null)).toBe("Adelanto");
  });
});

describe("qué se le puede hacer", () => {
  it("registrar: no en una cita cancelada ni en una cuenta ya cerrada", () => {
    expect(addBlockReason({ cancelled: false, accountClosed: false })).toBeNull();
    expect(addBlockReason({ cancelled: true, accountClosed: false })).toMatch(/cancelada/);
    expect(addBlockReason({ cancelled: false, accountClosed: true })).toMatch(/ya está cerrada/);
  });

  it("devolver: una vez, antes de cerrar la cuenta, y si ya viajó solo la dueña", () => {
    const base = { deposit: { ...dep(50_000), refunded_at: null }, accountClosed: false, pushed: false, canFixAfterSync: false };
    expect(refundBlockReason(base)).toBeNull();
    expect(refundBlockReason({ ...base, deposit: { ...dep(50_000, 1), refunded_at: new Date() } })).toMatch(/ya tiene/);
    expect(refundBlockReason({ ...base, accountClosed: true })).toMatch(/Corrige la cuenta/);
    expect(refundBlockReason({ ...base, pushed: true })).toMatch(/Solo la dueña/);
    expect(refundBlockReason({ ...base, pushed: true, canFixAfterSync: true })).toBeNull();
  });

  it("pasar a otra cita: con plata, sin usar, a una cuenta abierta y distinta", () => {
    const base = { deposit: dep(50_000), fromAccountClosed: false, toAccountClosed: false, sameAppointment: false };
    expect(moveBlockReason(base)).toBeNull();
    expect(moveBlockReason({ ...base, sameAppointment: true })).toMatch(/ya es de esta cita/);
    expect(moveBlockReason({ ...base, deposit: dep(50_000, 50_000) })).toMatch(/devolvió entero/);
    expect(moveBlockReason({ ...base, fromAccountClosed: true })).toMatch(/ya se usó/);
    expect(moveBlockReason({ ...base, toAccountClosed: true })).toMatch(/ya está cerrada/);
  });
});
