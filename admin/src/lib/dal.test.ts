import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AllowedIdentity } from "./auth-policy";

/**
 * El DAL, probado por donde importa: **llamando las funciones directamente**.
 *
 * La afirmación que este archivo tiene que sostener es que una técnica no
 * alcanza caja, reportes ni cuentas ajenas *sin pasar por la interfaz*. Un test
 * que solo verificara que el botón no se dibuja no probaría nada: la Server
 * Action que había detrás sigue existiendo, y se puede invocar sin botón.
 *
 * Lo que se dobla es el borde — la sesión de Better Auth y la lectura de la
 * allowlist — y nada más. La decisión que se está verificando es la del DAL.
 */

const ALLOWLIST: AllowedIdentity[] = [
  { email: "dueña@estudio.com", role: "owner", ea_provider_id: null },
  { email: "recepcion@estudio.com", role: "admin", ea_provider_id: null },
  { email: "lina@gmail.com", role: "staff", ea_provider_id: 7 },
];

/** Lo que devuelve `auth.api.getSession()`, o `null`. */
let sessionStub: { user: { id: string; email: string; name: string } } | null = null;

/** Lo que devuelve la allowlist. Se cambia para el caso "sacada de Equipo". */
let allowlistStub: AllowedIdentity[] = ALLOWLIST;

/** Un `redirect()` real lanza; acá se imita para poder afirmarlo. */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect(${to})`);
  }
}

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

/** Cuando está en `true`, la base "no responde". */
let baseCaida = false;

vi.mock("./auth", () => ({
  LOGIN_PATH: "/entrar",
  getAuth: () => ({
    api: {
      getSession: async () => {
        if (baseCaida) throw new Error("ECONNREFUSED");
        return sessionStub;
      },
    },
  }),
}));

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

vi.mock("@/db/repositories", () => ({
  allowedUserRepository: () => ({ list: async () => allowlistStub }),
}));

const {
  ForbiddenError,
  requireCapability,
  requireOwnProvider,
  requireSession,
  sessionCan,
  verifySession,
} = await import("./dal");

function entrarComo(email: string, name = "Alguien") {
  sessionStub = { user: { id: `u-${email}`, email, name } };
}

beforeEach(() => {
  sessionStub = null;
  allowlistStub = ALLOWLIST;
  baseCaida = false;
  delete process.env.TICKET_STAFF_COBRA;
});

afterEach(() => {
  delete process.env.TICKET_STAFF_COBRA;
});

describe("verifySession", () => {
  it("devuelve null sin cookie de sesión", async () => {
    expect(await verifySession()).toBeNull();
  });

  it("devuelve null para una sesión viva de alguien que ya no está en la allowlist", async () => {
    // El día que la dueña saca a alguien de Equipo. La fila desaparece y la
    // sesión abierta deja de valer en la request siguiente, sin esperar a que
    // venza una sesión de treinta días.
    entrarComo("lina@gmail.com");
    allowlistStub = ALLOWLIST.filter((e) => e.role !== "staff");
    expect(await verifySession()).toBeNull();
  });

  it("falla cerrada si la base no responde", async () => {
    // No hay forma de saber si la cookie corresponde a una sesión viva, y la
    // respuesta segura a "no sé" es que no. Un throw sería un 500 en cada
    // pantalla, incluida la de entrada.
    entrarComo("dueña@estudio.com");
    baseCaida = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifySession()).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("resuelve el rol y el provider desde allowed_user, no desde la sesión", async () => {
    entrarComo("lina@gmail.com", "Lina");
    expect(await verifySession()).toEqual({
      userId: "u-lina@gmail.com",
      email: "lina@gmail.com",
      name: "Lina",
      role: "staff",
      eaProviderId: 7,
    });
  });

  it("normaliza el correo de la sesión contra la allowlist", async () => {
    entrarComo("LINA@Gmail.com");
    expect((await verifySession())?.role).toBe("staff");
  });
});

describe("requireSession", () => {
  it("manda al login cuando no hay sesión", async () => {
    await expect(requireSession()).rejects.toThrow(RedirectSignal);
    await expect(requireSession()).rejects.toMatchObject({ to: "/entrar" });
  });

  it("devuelve la sesión cuando la hay", async () => {
    entrarComo("dueña@estudio.com", "Dueña");
    expect((await requireSession()).role).toBe("owner");
  });
});

describe("requireCapability — una técnica no alcanza lo que no es suyo", () => {
  const PROHIBIDAS = [
    "caja:ver",
    "caja:cerrar-dia",
    "reportes:ver",
    "cuenta:cerrar-ajena",
    "cuenta:corregir-tras-cierre",
    "comisiones:administrar",
    "equipo:administrar",
  ] as const;

  it.each(PROHIBIDAS)("staff → %s lanza ForbiddenError", async (capability) => {
    entrarComo("lina@gmail.com");
    await expect(requireCapability(capability)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("staff sí cierra su propia cuenta", async () => {
    entrarComo("lina@gmail.com");
    expect((await requireCapability("cuenta:cerrar-propia")).role).toBe("staff");
  });

  it("recepción cierra el día pero no corrige después del cierre", async () => {
    entrarComo("recepcion@estudio.com");
    expect((await requireCapability("caja:cerrar-dia")).role).toBe("admin");
    await expect(
      requireCapability("cuenta:corregir-tras-cierre"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("sin sesión, redirige antes de evaluar el permiso", async () => {
    await expect(requireCapability("caja:ver")).rejects.toThrow(RedirectSignal);
  });

  it("TICKET_STAFF_COBRA decide si la técnica registra el pago", async () => {
    entrarComo("lina@gmail.com");
    await expect(requireCapability("cuenta:cobrar")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    process.env.TICKET_STAFF_COBRA = "true";
    expect((await requireCapability("cuenta:cobrar")).role).toBe("staff");

    // Cualquier cosa que no sea exactamente "true" es no. Un permiso se
    // concede; no se supone.
    process.env.TICKET_STAFF_COBRA = "1";
    await expect(requireCapability("cuenta:cobrar")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("el error nombra la capacidad, para que un handler pueda mapearlo a 403", async () => {
    entrarComo("lina@gmail.com");
    await expect(requireCapability("reportes:ver")).rejects.toMatchObject({
      name: "ForbiddenError",
      capability: "reportes:ver",
    });
  });
});

describe("sessionCan", () => {
  it("es false sin sesión, sin lanzar", async () => {
    expect(await sessionCan("caja:ver")).toBe(false);
  });

  it("refleja la matriz", async () => {
    entrarComo("lina@gmail.com");
    expect(await sessionCan("caja:ver")).toBe(false);
    expect(await sessionCan("liquidacion:ver-propia")).toBe(true);
  });
});

describe("requireOwnProvider — cuál cita, no solo qué operación", () => {
  it("una técnica no alcanza la cita de otra", async () => {
    entrarComo("lina@gmail.com");
    await expect(requireOwnProvider(9)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("una técnica alcanza la suya", async () => {
    entrarComo("lina@gmail.com");
    expect((await requireOwnProvider(7)).eaProviderId).toBe(7);
  });

  it("recepción alcanza la de cualquiera", async () => {
    entrarComo("recepcion@estudio.com");
    expect((await requireOwnProvider(7)).role).toBe("admin");
  });

  it("sin sesión, redirige", async () => {
    await expect(requireOwnProvider(7)).rejects.toThrow(RedirectSignal);
  });
});
