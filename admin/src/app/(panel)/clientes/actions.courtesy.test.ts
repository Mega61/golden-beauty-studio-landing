import { beforeEach, describe, expect, it, vi } from "vitest";

import { can } from "@/lib/auth-policy";
import type { UserRole } from "@/db/types";

/**
 * "Cortesía de la casa por defecto" en la ficha: la Server Action, llamada
 * directo. Solo la dueña la cambia; recepción y la técnica reciben un no y no
 * se escribe nada. La matriz de permisos que decide es la real (`can()`), no un
 * doble.
 */

let role: UserRole;
let writes: { what: string; args: unknown[] }[];
let marcadas: Set<number>;

class ForbiddenError extends Error {}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

vi.mock("@/lib/dal", () => ({
  ForbiddenError,
  requireCapability: async (capability: Parameters<typeof can>[1]) => {
    if (!can(role, capability)) throw new ForbiddenError(capability);
    return { userId: `usr_${role}`, role, eaProviderId: null };
  },
}));

const fakeDb = {
  transaction: () => ({
    execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(fakeDb),
  }),
};

vi.mock("@/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/db/repositories", () => ({
  auditLogRepository: () => ({ append: async () => {} }),
  repositories: () => ({
    customerSettings: {
      listHouseCourtesyIds: async () => new Set(marcadas),
      setHouseCourtesy: async (...args: unknown[]) => {
        writes.push({ what: "setHouseCourtesy", args });
      },
    },
    auditLog: {
      append: async (...args: unknown[]) => {
        writes.push({ what: "auditLog.append", args });
      },
    },
  }),
}));
vi.mock("@/lib/ea/client", () => ({ createEaClient: () => ({}) }));

const { marcarCortesiaPorDefecto } = await import("./actions");

beforeEach(() => {
  role = "owner";
  writes = [];
  marcadas = new Set();
});

describe("marcarCortesiaPorDefecto", () => {
  it.each(["staff", "admin"] as const)("%s no puede marcarla y no se escribe nada", async (r) => {
    role = r;
    const result = await marcarCortesiaPorDefecto([482], true);
    expect(result).toEqual({
      ok: false,
      message: "Solo la dueña marca a una clienta como cortesía de la casa.",
    });
    expect(writes).toEqual([]);
  });

  it("la dueña la marca en todas las fichas de la persona, con bitácora", async () => {
    const result = await marcarCortesiaPorDefecto([482, 517, 482], true);
    expect(result.ok).toBe(true);
    expect(writes[0]).toEqual({
      what: "setHouseCourtesy",
      args: [[482, 517], true, "usr_owner"],
    });
    expect(writes[1].what).toBe("auditLog.append");
    expect(writes[1].args[0]).toMatchObject({
      action: "clienta.cortesia",
      entity: "ea_customer",
      entityId: "482",
      before: { eaCustomerIds: [482, 517], houseCourtesyDefault: [] },
      after: { eaCustomerIds: [482, 517], houseCourtesyDefault: true },
    });
  });

  it("la dueña la desmarca", async () => {
    marcadas = new Set([482]);
    const result = await marcarCortesiaPorDefecto([482], false);
    expect(result.ok).toBe(true);
    expect(writes[0].args).toEqual([[482], false, "usr_owner"]);
    expect(writes[1].args[0]).toMatchObject({ before: { houseCourtesyDefault: [482] } });
  });

  it("rechaza ids que no son fichas", async () => {
    expect(await marcarCortesiaPorDefecto([0, -3, 1.5], true)).toMatchObject({ ok: false });
    expect(writes).toEqual([]);
  });
});
