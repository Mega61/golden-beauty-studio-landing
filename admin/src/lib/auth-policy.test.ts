import { describe, expect, it } from "vitest";

import {
  can,
  checkWorkspaceClaims,
  findAllowedEntry,
  isAllowedIdentity,
  normalizeEmail,
  ownsProvider,
  type AllowedIdentity,
  type Capability,
} from "./auth-policy";

/**
 * Los casos negativos van primero, y no es orden alfabético.
 *
 * Un test que solo prueba que la dueña puede entrar no prueba nada: pasa
 * igual con una función que devuelve `true` siempre. Lo que fija que esto es
 * una compuerta son los tres rechazos.
 */

const DOMINIO = "goldenbeautystudio.com.co";

const ALLOWLIST: AllowedIdentity[] = [
  { email: "dueña@goldenbeautystudio.com.co", role: "owner", ea_provider_id: 3 },
  { email: "recepcion@goldenbeautystudio.com.co", role: "admin", ea_provider_id: null },
  { email: "lina@gmail.com", role: "staff", ea_provider_id: 7 },
];

function claims(over: Record<string, unknown> = {}) {
  return {
    email: "dueña@goldenbeautystudio.com.co",
    email_verified: true,
    hd: DOMINIO,
    ...over,
  };
}

describe("isAllowedIdentity — los tres casos de Workspace", () => {
  it("rechaza una cuenta @gmail.com por el claim hd", () => {
    // El correo personal de la técnica: existe en la allowlist con rol staff,
    // y aun así la puerta de Workspace no es la suya. Que esté en la lista no
    // la habilita a entrar por Google.
    const decision = isAllowedIdentity(
      claims({ email: "lina@gmail.com", hd: undefined }),
      ALLOWLIST,
      DOMINIO,
    );
    expect(decision).toEqual({ ok: false, reason: "dominio" });
  });

  it("rechaza una cuenta del dominio que no está en la allowlist", () => {
    const decision = isAllowedIdentity(
      claims({ email: "contadora@goldenbeautystudio.com.co" }),
      ALLOWLIST,
      DOMINIO,
    );
    expect(decision).toEqual({ ok: false, reason: "fuera_de_allowlist" });
  });

  it("acepta una cuenta del dominio que sí está, con su rol y su provider", () => {
    expect(isAllowedIdentity(claims(), ALLOWLIST, DOMINIO)).toEqual({
      ok: true,
      email: "dueña@goldenbeautystudio.com.co",
      role: "owner",
      eaProviderId: 3,
    });
  });
});

describe("checkWorkspaceClaims", () => {
  it("rechaza un hd de otro dominio de Workspace", () => {
    expect(checkWorkspaceClaims(claims({ hd: "otroestudio.com" }), DOMINIO)).toEqual({
      ok: false,
      reason: "dominio",
    });
  });

  it("rechaza cuando el hd no es una cadena", () => {
    expect(checkWorkspaceClaims(claims({ hd: 42 }), DOMINIO)).toEqual({
      ok: false,
      reason: "dominio",
    });
  });

  it("rechaza cuando el dominio configurado viene vacío", () => {
    // Un `GOOGLE_WORKSPACE_DOMAIN=""` no puede degradarse a "acepta cualquiera".
    expect(checkWorkspaceClaims(claims(), "   ")).toEqual({
      ok: false,
      reason: "dominio",
    });
  });

  it('rechaza email_verified: "true" (la cadena, que en JS es verdadera)', () => {
    expect(checkWorkspaceClaims(claims({ email_verified: "true" }), DOMINIO)).toEqual({
      ok: false,
      reason: "email_sin_verificar",
    });
  });

  it("rechaza email_verified: false", () => {
    expect(checkWorkspaceClaims(claims({ email_verified: false }), DOMINIO)).toEqual({
      ok: false,
      reason: "email_sin_verificar",
    });
  });

  it("rechaza un token sin correo", () => {
    expect(checkWorkspaceClaims(claims({ email: undefined }), DOMINIO)).toEqual({
      ok: false,
      reason: "sin_email",
    });
  });

  it("compara el dominio sin distinguir mayúsculas ni espacios", () => {
    const decision = checkWorkspaceClaims(
      claims({ hd: " GoldenBeautyStudio.COM.co " }),
      ` ${DOMINIO.toUpperCase()} `,
    );
    expect(decision.ok).toBe(true);
  });
});

describe("normalizeEmail", () => {
  it("devuelve null para lo que no es una cadena", () => {
    expect(normalizeEmail(123)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("devuelve null para una cadena sin forma de correo", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("no-es-un-correo")).toBeNull();
    expect(normalizeEmail("dos@arrobas@x.com")).toBeNull();
  });

  it("baja a minúsculas y recorta", () => {
    expect(normalizeEmail("  Ana@Estudio.COM  ")).toBe("ana@estudio.com");
  });
});

describe("findAllowedEntry", () => {
  it("encuentra sin distinguir mayúsculas", () => {
    expect(findAllowedEntry("LINA@GMAIL.COM", ALLOWLIST)?.role).toBe("staff");
  });

  it("devuelve null para un correo ausente y para basura", () => {
    expect(findAllowedEntry("nadie@estudio.com", ALLOWLIST)).toBeNull();
    expect(findAllowedEntry(42, ALLOWLIST)).toBeNull();
  });
});

// ── La matriz ───────────────────────────────────────────────────────────────

/**
 * El test que el paquete tiene que poder mostrar: **una técnica no alcanza caja
 * ni reportes llamando la función directamente**, no solo con el botón
 * escondido.
 */
describe("can — el alcance de una técnica", () => {
  const PROHIBIDAS: Capability[] = [
    "caja:ver",
    "caja:cerrar-dia",
    "reportes:ver",
    "cuenta:cerrar-ajena",
    "cuenta:corregir-tras-cierre",
    "agenda:ver-todas",
    "liquidacion:ver-todas",
    "comisiones:administrar",
    "equipo:administrar",
    "catalogo:publicar",
    "diagnostico:ver",
    "ea:avanzado",
  ];

  it.each(PROHIBIDAS)("staff NO alcanza %s", (capability) => {
    expect(can("staff", capability)).toBe(false);
    expect(can("staff", capability, { staffCobra: true })).toBe(false);
  });

  it("staff cierra su propia cuenta y ve su propia liquidación", () => {
    expect(can("staff", "cuenta:cerrar-propia")).toBe(true);
    expect(can("staff", "liquidacion:ver-propia")).toBe(true);
  });

  it("staff cobra solo si TICKET_STAFF_COBRA está encendida", () => {
    expect(can("staff", "cuenta:cobrar")).toBe(false);
    expect(can("staff", "cuenta:cobrar", {})).toBe(false);
    expect(can("staff", "cuenta:cobrar", { staffCobra: false })).toBe(false);
    expect(can("staff", "cuenta:cobrar", { staffCobra: true })).toBe(true);
  });
});

describe("can — recepción y dueña", () => {
  it("recepción opera el día pero no corrige después del cierre", () => {
    expect(can("admin", "caja:cerrar-dia")).toBe(true);
    expect(can("admin", "cuenta:cerrar-ajena")).toBe(true);
    expect(can("admin", "cuenta:cobrar")).toBe(true);
    expect(can("admin", "reportes:ver")).toBe(true);
    expect(can("admin", "cuenta:corregir-tras-cierre")).toBe(false);
  });

  it("recepción no administra personas, reglas ni el catálogo", () => {
    expect(can("admin", "equipo:administrar")).toBe(false);
    expect(can("admin", "comisiones:administrar")).toBe(false);
    expect(can("admin", "catalogo:publicar")).toBe(false);
    expect(can("admin", "ea:avanzado")).toBe(false);
    expect(can("admin", "liquidacion:ver-todas")).toBe(false);
  });

  it("la dueña alcanza todo", () => {
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
    for (const capability of TODAS) {
      expect(can("owner", capability)).toBe(true);
    }
  });
});

describe("ownsProvider", () => {
  it("una técnica no alcanza la cita de otra", () => {
    expect(ownsProvider("staff", 7, 9)).toBe(false);
  });

  it("una técnica sin ea_provider_id no alcanza nada", () => {
    // Fila a medio configurar en Equipo. La respuesta segura es que no, incluso
    // contra una cita que tampoco tiene provider.
    expect(ownsProvider("staff", null, 7)).toBe(false);
    expect(ownsProvider("staff", null, null)).toBe(false);
  });

  it("una técnica alcanza la suya", () => {
    expect(ownsProvider("staff", 7, 7)).toBe(true);
  });

  it("recepción y dueña alcanzan cualquiera", () => {
    expect(ownsProvider("admin", null, 7)).toBe(true);
    expect(ownsProvider("owner", null, 7)).toBe(true);
  });
});
