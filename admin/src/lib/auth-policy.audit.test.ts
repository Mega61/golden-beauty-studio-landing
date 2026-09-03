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

import type { UserRole } from "@/db/types";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B2.
 */

const DOMINIO = "goldenbeautystudio.com.co";

const ALLOWLIST: AllowedIdentity[] = [
  { email: "duena@goldenbeautystudio.com.co", role: "owner", ea_provider_id: null },
  { email: "recepcion@goldenbeautystudio.com.co", role: "admin", ea_provider_id: null },
  { email: "lina@gmail.com", role: "staff", ea_provider_id: 7 },
];

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

/**
 * La matriz **transcrita del plan**, no del código: § Cuenta de servicio (tabla
 * "Quién puede qué") y § Navegación ("Rol `staff`: ve Hoy (su día), Agenda (su
 * columna), cierra la cuenta de sus propias citas y ve su liquidación […]. No ve
 * totales del día, ni reportes, ni a las demás profesionales, ni puede hacer el
 * cierre diario").
 */
const DEL_PLAN: Record<UserRole, Record<Capability, boolean | "segun-cobra">> = {
  owner: Object.fromEntries(TODAS.map((c) => [c, true])) as Record<Capability, boolean>,
  admin: {
    "cuenta:cerrar-propia": true,
    "cuenta:cerrar-ajena": true,
    "cuenta:cobrar": true,
    "cuenta:corregir-tras-cierre": false,
    "caja:ver": true,
    "caja:cerrar-dia": true,
    "reportes:ver": true,
    "agenda:ver-todas": true,
    "liquidacion:ver-propia": false,
    "liquidacion:ver-todas": false,
    "comisiones:administrar": false,
    "equipo:administrar": false,
    "catalogo:publicar": false,
    "diagnostico:ver": true,
    "ea:avanzado": false,
  },
  staff: {
    "cuenta:cerrar-propia": true,
    "cuenta:cerrar-ajena": false,
    "cuenta:cobrar": "segun-cobra",
    "cuenta:corregir-tras-cierre": false,
    "caja:ver": false,
    "caja:cerrar-dia": false,
    "reportes:ver": false,
    "agenda:ver-todas": false,
    "liquidacion:ver-propia": true,
    "liquidacion:ver-todas": false,
    "comisiones:administrar": false,
    "equipo:administrar": false,
    "catalogo:publicar": false,
    "diagnostico:ver": false,
    "ea:avanzado": false,
  },
};

describe("AUDIT · la matriz completa, celda por celda, contra el plan", () => {
  it("45 celdas × las dos posiciones de TICKET_STAFF_COBRA", () => {
    for (const role of ["owner", "admin", "staff"] as UserRole[]) {
      for (const capability of TODAS) {
        const esperado = DEL_PLAN[role][capability];

        for (const staffCobra of [undefined, false, true]) {
          const real = can(role, capability, { staffCobra });
          const debe =
            esperado === "segun-cobra" ? staffCobra === true : esperado;

          expect(real, `${role} · ${capability} · cobra=${staffCobra}`).toBe(debe);
        }
      }
    }
  });

  it("`staffCobra` solo concede con el booleano exacto, nunca con una verdad blanda", () => {
    for (const blando of ["true", 1, "1", "yes", {}, []] as unknown[]) {
      expect(can("staff", "cuenta:cobrar", { staffCobra: blando as boolean })).toBe(false);
    }
  });

  it("`cuenta:cobrar` de owner y admin no depende de la env var", () => {
    for (const staffCobra of [undefined, false, true]) {
      expect(can("owner", "cuenta:cobrar", { staffCobra })).toBe(true);
      expect(can("admin", "cuenta:cobrar", { staffCobra })).toBe(true);
    }
  });
});

describe("AUDIT · ownsProvider, exhaustivo", () => {
  it("una staff solo alcanza su propio provider; owner y admin, cualquiera", () => {
    const ids: (number | null)[] = [null, 0, 1, 7, 8, 999];

    for (const sesion of ids) {
      for (const target of ids) {
        expect(ownsProvider("owner", sesion, target)).toBe(true);
        expect(ownsProvider("admin", sesion, target)).toBe(true);
        expect(ownsProvider("staff", sesion, target)).toBe(
          sesion !== null && sesion === target,
        );
      }
    }
  });
});

describe("AUDIT · las compuertas de Workspace", () => {
  it("producto cartesiano de hd × email_verified × allowlist", () => {
    const emails = [
      "duena@goldenbeautystudio.com.co",
      "ajeno@goldenbeautystudio.com.co",
      "lina@gmail.com",
      "",
      "sin-arroba",
      123,
      null,
    ];
    const hds = [DOMINIO, "GoldenBeautyStudio.com.co", " goldenbeautystudio.com.co ", "otro.com", "gmail.com", "", null, 123];
    const verificados = [true, false, "true", "false", 1, 0, null, undefined];

    for (const email of emails) {
      for (const hd of hds) {
        for (const email_verified of verificados) {
          const d = isAllowedIdentity(
            { email, hd, email_verified } as never,
            ALLOWLIST,
            DOMINIO,
          );

          const normalizado = normalizeEmail(email);
          const emailOk = normalizado !== null;
          const hdOk =
            typeof hd === "string" && hd.trim().toLowerCase() === DOMINIO;
          // El dominio del correo tiene que ser el de Workspace, no solo el
          // claim `hd`. Esta línea es el arreglo de H6 expresado como
          // expectativa: sin ella, este barrido afirmaba que
          // `lina@gmail.com` + `hd` del estudio **debía** entrar, que es
          // exactamente el agujero que el hallazgo H6 reportó. El barrido
          // codificaba el comportamiento observado; el test dirigido de H6
          // codificaba la intención. Mandaba la intención.
          const dominioCorreoOk =
            normalizado !== null &&
            normalizado.slice(normalizado.lastIndexOf("@") + 1) === DOMINIO;
          const verifOk = email_verified === true;
          const enLista = findAllowedEntry(email, ALLOWLIST) !== null;

          expect(d.ok, JSON.stringify({ email, hd, email_verified })).toBe(
            emailOk && hdOk && dominioCorreoOk && verifOk && enLista,
          );
        }
      }
    }
  });

  it("un dominio de Workspace vacío no puede volverse 'acepta cualquier cosa'", () => {
    for (const domain of ["", "   "]) {
      for (const hd of [DOMINIO, "", "   ", null]) {
        expect(
          checkWorkspaceClaims(
            { email: "duena@goldenbeautystudio.com.co", hd, email_verified: true } as never,
            domain,
          ).ok,
        ).toBe(false);
      }
    }
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 9 — la compuerta `hd` no compara contra el dominio del correo.
 *
 * § Auth: "el claim `hd` del ID token debe igualar el dominio de Workspace **y**
 * `email_verified` debe ser true". `hd` es el *hosted domain* de la cuenta, y su
 * trabajo es afirmar que la identidad pertenece al Workspace del estudio. El
 * código lo lee como un valor suelto y nunca lo cruza con el correo, así que un
 * token con `email: "lina@gmail.com"` + `hd: "<dominio del estudio>"` pasa las
 * dos compuertas.
 *
 * No es teórico por dónde cae: las técnicas entran con **correo personal** y su
 * fila `staff` vive en la misma `allowed_user` que consulta esta función, así que
 * la tercera compuerta tampoco lo detiene. El test existente del builder se
 * llama "rechaza una cuenta @gmail.com por el claim hd" y solo pasa porque
 * Google no manda `hd` en un token de Gmail: la afirmación que su nombre hace no
 * es la que el código sostiene.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · el hd tiene que describir al correo que viene en el token", () => {
  it("un correo personal con el hd del estudio no es una identidad de Workspace", () => {
    const decision = isAllowedIdentity(
      { email: "lina@gmail.com", hd: DOMINIO, email_verified: true },
      ALLOWLIST,
      DOMINIO,
    );

    expect(decision).toEqual({ ok: false, reason: "dominio" });
  });
});
