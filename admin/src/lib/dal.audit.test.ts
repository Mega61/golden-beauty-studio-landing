import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AllowedIdentity, Capability } from "./auth-policy";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B2.
 *
 * DoD de B2: "un `staff` no alcanza rutas de caja ni de reportes **en el DAL**,
 * no solo en la UI". Se llaman las funciones directamente, sin pantalla de por
 * medio, sobre las quince capacidades — no sobre las tres que la UI dibuja.
 */

const ALLOWLIST: AllowedIdentity[] = [
  { email: "duena@estudio.com", role: "owner", ea_provider_id: null },
  { email: "recepcion@estudio.com", role: "admin", ea_provider_id: null },
  { email: "lina@gmail.com", role: "staff", ea_provider_id: 7 },
  { email: "sofia@gmail.com", role: "staff", ea_provider_id: 8 },
  { email: "nueva@gmail.com", role: "staff", ea_provider_id: null },
];

let sessionStub: { user: { id: string; email: string; name: string } } | null = null;
let allowlistStub: AllowedIdentity[] = ALLOWLIST;

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect(${to})`);
  }
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

vi.mock("./auth", () => ({
  LOGIN_PATH: "/entrar",
  getAuth: () => ({ api: { getSession: async () => sessionStub } }),
}));

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

vi.mock("@/db/repositories", () => ({
  allowedUserRepository: () => ({ list: async () => allowlistStub }),
}));

const { ForbiddenError, requireCapability, requireOwnProvider, sessionCan, verifySession } =
  await import("./dal");

function entrarComo(email: string) {
  sessionStub = { user: { id: `u-${email}`, email, name: "Alguien" } };
}

const TODAS: Capability[] = [
  "cuenta:cerrar-propia",
  "cuenta:cerrar-ajena",
  "cuenta:cobrar",
  "cuenta:corregir-tras-cierre",
  "caja:ver",
  "caja:cerrar-dia",
  "reportes:ver",
  "agenda:ver-todas",
  "liquidacion:ver-propia",
  "liquidacion:ver-todas",
  "comisiones:administrar",
  "equipo:administrar",
  "catalogo:publicar",
  "diagnostico:ver",
  "ea:avanzado",
];

/** Lo que una técnica NO puede alcanzar, ni con un formulario armado a mano. */
const PROHIBIDO_A_STAFF: Capability[] = TODAS.filter(
  (c) => c !== "cuenta:cerrar-propia" && c !== "liquidacion:ver-propia" && c !== "cuenta:cobrar",
);

beforeEach(() => {
  sessionStub = null;
  allowlistStub = ALLOWLIST;
  delete process.env.TICKET_STAFF_COBRA;
});

afterEach(() => {
  delete process.env.TICKET_STAFF_COBRA;
});

describe("AUDIT · una técnica llamando el DAL directamente", () => {
  it("las doce capacidades que no son suyas lanzan ForbiddenError", async () => {
    entrarComo("lina@gmail.com");

    for (const capability of PROHIBIDO_A_STAFF) {
      await expect(requireCapability(capability), capability).rejects.toThrow(ForbiddenError);
      expect(await sessionCan(capability), capability).toBe(false);
    }
  });

  it("las dos que sí son suyas pasan", async () => {
    entrarComo("lina@gmail.com");

    for (const capability of ["cuenta:cerrar-propia", "liquidacion:ver-propia"] as Capability[]) {
      await expect(requireCapability(capability)).resolves.toMatchObject({ role: "staff" });
    }
  });

  it("`cuenta:cobrar` solo con TICKET_STAFF_COBRA exactamente en 'true'", async () => {
    entrarComo("lina@gmail.com");

    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) {
      if (value === undefined) delete process.env.TICKET_STAFF_COBRA;
      else process.env.TICKET_STAFF_COBRA = value;

      await expect(requireCapability("cuenta:cobrar"), String(value)).rejects.toThrow(
        ForbiddenError,
      );
    }

    process.env.TICKET_STAFF_COBRA = "true";
    await expect(requireCapability("cuenta:cobrar")).resolves.toMatchObject({ role: "staff" });
  });

  it("no alcanza la cita de otra técnica, para ningún provider ajeno", async () => {
    entrarComo("lina@gmail.com"); // provider 7

    for (const target of [null, 0, 1, 8, 999]) {
      await expect(requireOwnProvider(target), String(target)).rejects.toThrow(ForbiddenError);
    }

    await expect(requireOwnProvider(7)).resolves.toMatchObject({ eaProviderId: 7 });
  });

  it("una staff a medio configurar (sin ea_provider_id) no alcanza ninguna cita", async () => {
    entrarComo("nueva@gmail.com");

    for (const target of [null, 7, 8]) {
      await expect(requireOwnProvider(target), String(target)).rejects.toThrow(ForbiddenError);
    }
  });
});

describe("AUDIT · recepción y dueña", () => {
  it("recepción alcanza ocho capacidades y no las otras siete", async () => {
    entrarComo("recepcion@estudio.com");

    const permitidas: Capability[] = [
      "cuenta:cerrar-propia",
      "cuenta:cerrar-ajena",
      "cuenta:cobrar",
      "caja:ver",
      "caja:cerrar-dia",
      "reportes:ver",
      "agenda:ver-todas",
      "diagnostico:ver",
    ];

    for (const capability of TODAS) {
      const puede = permitidas.includes(capability);
      expect(await sessionCan(capability), capability).toBe(puede);
    }
  });

  it("la dueña alcanza las quince", async () => {
    entrarComo("duena@estudio.com");

    for (const capability of TODAS) {
      await expect(requireCapability(capability), capability).resolves.toMatchObject({
        role: "owner",
      });
    }
  });
});

describe("AUDIT · el rol se relee de allowed_user en cada verificación", () => {
  it("degradar a la dueña a staff la deja fuera en la request siguiente", async () => {
    entrarComo("duena@estudio.com");
    expect((await verifySession())?.role).toBe("owner");

    allowlistStub = ALLOWLIST.map((e) =>
      e.email === "duena@estudio.com" ? { ...e, role: "staff" as const, ea_provider_id: 9 } : e,
    );

    // `cache()` de React memoiza **por request**; en un proceso de test sin
    // scope de request no debe sobrevivir entre llamadas, o un cambio de rol
    // tardaría en verse.
    expect((await verifySession())?.role).toBe("staff");
    await expect(requireCapability("caja:cerrar-dia")).rejects.toThrow(ForbiddenError);
  });

  it("sacarla de Equipo la saca del panel aunque la sesión siga viva", async () => {
    entrarComo("lina@gmail.com");
    expect(await verifySession()).not.toBeNull();

    allowlistStub = ALLOWLIST.filter((e) => e.email !== "lina@gmail.com");

    expect(await verifySession()).toBeNull();
    await expect(requireCapability("cuenta:cerrar-propia")).rejects.toThrow(RedirectSignal);
  });
});
