import { describe, expect, it, vi } from "vitest";

import type { AllowedIdentity } from "./auth-policy";

/**
 * La configuración de Better Auth, verificada como configuración.
 *
 * No se prueba la librería: se prueba que **nuestras** decisiones estén donde
 * dijimos. Son cuatro, y las cuatro se rompen en silencio si alguien las mueve —
 * una cookie con `Domain`, un `baseURL` derivado, un `hd` sin poner o una sesión
 * de un día no fallan ningún build ni ningún test de otra cosa; solo aparecen el
 * día que algo no funciona en producción.
 *
 * Y se prueba la **compuerta**: `validateUserInfo` es el punto donde la decisión
 * pura de `auth-policy.ts` se conecta con el flujo real. Que la función sea
 * correcta y esté mal cableada es exactamente el mismo agujero que no tenerla.
 */

const ALLOWLIST: AllowedIdentity[] = [
  { email: "dueña@goldenbeautystudio.com.co", role: "owner", ea_provider_id: null },
  { email: "lina@gmail.com", role: "staff", ea_provider_id: 7 },
];

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));

vi.mock("@/db/repositories", () => ({
  allowedUserRepository: () => ({ list: async () => ALLOWLIST }),
  staffTotpRepository: () => ({}),
}));

const BASE = "https://goldenbeautystudio.com.co/admin";
const DOMINIO = "goldenbeautystudio.com.co";

process.env.BETTER_AUTH_URL = BASE;
process.env.BETTER_AUTH_SECRET = "x".repeat(32);
process.env.GOOGLE_WORKSPACE_DOMAIN = DOMINIO;
process.env.GOOGLE_CLIENT_ID = "cliente.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "secreto";

const { LOGIN_PATH, authMountUrl, getAuth, panelUrl } = await import("./auth");

const options = getAuth().options;

describe("panelUrl", () => {
  it("arma URLs absolutas dentro del panel", () => {
    expect(panelUrl("/entrar")).toBe(`${BASE}/entrar`);
  });

  it("no duplica la barra cuando BETTER_AUTH_URL trae una al final", () => {
    expect(panelUrl("/entrar", { BETTER_AUTH_URL: `${BASE}/` })).toBe(
      `${BASE}/entrar`,
    );
  });

  it("lanza si falta BETTER_AUTH_URL", () => {
    expect(() => panelUrl("/entrar", {})).toThrow(/BETTER_AUTH_URL/);
  });
});

describe("la configuración", () => {
  it("fija baseURL y trustedOrigins desde la variable, no desde la request", () => {
    // Detrás del rewrite de la landing el `Host` upstream es el de la VM: una
    // base derivada armaría el redirect de Google contra el host equivocado.
    //
    // El `baseURL` que recibe Better Auth **incluye** `/api/auth`: cuando el
    // baseURL trae un path, la librería ignora `basePath` y monta el router en
    // ese path tal cual. Con `…/admin` a secas los endpoints quedarían en
    // `/admin/get-session` y el redirect URI del plan no existiría. Ver la
    // corrección en la cabecera de `auth.ts`.
    expect(options.baseURL).toBe(`${BASE}/api/auth`);
    expect(options.trustedOrigins).toEqual(["https://goldenbeautystudio.com.co"]);
  });

  it("el punto de montaje coincide con el redirect URI que pide el plan", () => {
    // Es el que se registra en Google Cloud y el que no se puede cambiar sin
    // entrar a la consola.
    expect(`${authMountUrl()}/callback/google`).toBe(
      "https://goldenbeautystudio.com.co/admin/api/auth/callback/google",
    );
  });

  it("manda los errores de OAuth a la pantalla de entrada", () => {
    expect(options.onAPIError?.errorURL).toBe(`${BASE}${LOGIN_PATH}`);
  });

  it("emite la cookie sin Domain, httpOnly, secure, lax y acotada a /admin", () => {
    const cookie = options.advanced?.defaultCookieAttributes;
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/admin",
    });
    // Sin `Domain` el navegador la asocia al apex que la emitió; con
    // `crossSubDomainCookies` viajaría a la landing y a cualquier subdominio.
    expect(cookie).not.toHaveProperty("domain");
    expect(Object.keys(options.advanced ?? {})).not.toContain(
      "crossSubDomainCookies",
    );
  });

  it("da sesión de 30 días que se desliza cada día", () => {
    expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 30);
    expect(options.session?.updateAge).toBe(60 * 60 * 24);
  });

  it("exige el dominio de Workspace en el proveedor de Google", () => {
    expect(options.socialProviders?.google?.hd).toBe(DOMINIO);
  });

  it("no habilita entrada por correo y contraseña", () => {
    // No hay contraseñas en este panel: Workspace o TOTP. Una tercera puerta
    // habilitada por defecto sería una puerta que nadie está mirando; Better
    // Auth la deja apagada salvo que se la nombre, así que lo que se afirma es
    // que no está nombrada.
    expect(Object.keys(options)).not.toContain("emailAndPassword");
  });

  it("expone el sign-in de TOTP en la API de servidor", () => {
    expect(typeof getAuth().api.signInTotp).toBe("function");
  });

  it("es la misma instancia en cada llamada", () => {
    expect(getAuth()).toBe(getAuth());
  });
});

describe("validateUserInfo — la compuerta, cableada", () => {
  const gate = options.user?.validateUserInfo;

  function google(profile: Record<string, unknown>) {
    return {
      user: { email: String(profile.email ?? "") },
      source: {
        action: "sign-in" as const,
        method: "oauth" as const,
        oauth: { providerId: "google", profile },
      },
    };
  }

  it("está configurada", () => {
    expect(gate).toBeTypeOf("function");
  });

  it("rechaza una cuenta @gmail.com aunque esté en la allowlist", async () => {
    // Lina existe con rol staff, pero su puerta es el TOTP. La allowlist dice
    // qué rol tiene alguien, no de qué proveedor puede venir.
    const result = await gate?.(
      google({ email: "lina@gmail.com", email_verified: true }),
    );
    expect(result).toEqual({ error: "acceso_denegado" });
  });

  it("rechaza una cuenta del dominio que no está en la allowlist", async () => {
    const result = await gate?.(
      google({
        email: "contadora@goldenbeautystudio.com.co",
        email_verified: true,
        hd: DOMINIO,
      }),
    );
    expect(result).toEqual({ error: "acceso_denegado" });
  });

  it("acepta una cuenta del dominio que sí está", async () => {
    const result = await gate?.(
      google({
        email: "dueña@goldenbeautystudio.com.co",
        email_verified: true,
        hd: DOMINIO,
      }),
    );
    expect(result).toBeUndefined();
  });

  it("rechaza un correo del dominio sin verificar", async () => {
    const result = await gate?.(
      google({
        email: "dueña@goldenbeautystudio.com.co",
        email_verified: false,
        hd: DOMINIO,
      }),
    );
    expect(result).toEqual({ error: "acceso_denegado" });
  });

  it("para un método que no es OAuth exige igual la allowlist", async () => {
    // Es el camino del enrolamiento de una técnica: correo personal, sin
    // compuertas de Workspace, pero con la fila que la dueña creó.
    const permitido = await gate?.(
      {
        user: { email: "lina@gmail.com" },
        source: { action: "create-user", method: "admin" },
      },
    );
    expect(permitido).toBeUndefined();

    const ajeno = await gate?.(
      {
        user: { email: "cualquiera@gmail.com" },
        source: { action: "create-user", method: "admin" },
      },
    );
    expect(ajeno).toEqual({ error: "acceso_denegado" });
  });
});
