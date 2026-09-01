import "server-only";

import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";
import * as z from "zod";

import { getDb } from "@/db/client";
import { allowedUserRepository, staffTotpRepository } from "@/db/repositories";
import type { StaffTotp } from "@/db/types";
import type { AllowedIdentity } from "./auth-policy";
import { findAllowedEntry, isAllowedIdentity } from "./auth-policy";
import type { TotpEnrollment } from "./totp";
import {
  buildOtpauthUrl,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  planTotpAttempt,
  registerFailure,
  requireTotpEncKey,
  verifyTotpCode,
} from "./totp";

/**
 * Better Auth, configurado para las dos identidades que entran al panel.
 *
 * ## Dos caminos de entrada, un solo DAL
 *
 * - **Workspace** (dueña y recepción): proveedor social Google. Tres
 *   compuertas, todas obligatorias — el claim `hd` firmado igual al dominio del
 *   estudio, `email_verified === true`, y el correo presente en `allowed_user`.
 *   La decisión vive en `auth-policy.ts`, testeada; acá solo se conecta.
 * - **TOTP** (las técnicas): correo personal, sin cuenta de Workspace, sin
 *   contraseña. Un código de seis dígitos y nada más. Es la ruta que Better
 *   Auth no trae, y está construida abajo como plugin.
 *
 * Las dos terminan en la misma sesión de Better Auth, así que `dal.ts` no
 * necesita saber por dónde entró nadie.
 *
 * ## Por qué el TOTP es un plugin y no un Route Handler suelto
 *
 * La cookie de sesión de Better Auth va **firmada** con el secreto de la
 * instancia (`setSignedCookie` dentro de `setSessionCookie`,
 * `node_modules/better-auth/dist/cookies/index.mjs:172`). Escribirla desde un
 * handler propio obligaría a reimplementar esa firma y a mantenerla al día con
 * cada versión de la librería; el día que se desincronice, el síntoma es "nadie
 * puede iniciar sesión". Un endpoint de plugin corre dentro del contexto de
 * Better Auth y puede llamar `setSessionCookie` tal cual, que es exactamente lo
 * que hacen sus propios plugins de entrada sin contraseña — ver
 * `dist/plugins/magic-link/index.mjs:181-185`.
 *
 * ## `baseURL` fijado, no derivado
 *
 * El panel se sirve en `goldenbeautystudio.com.co/admin` pero corre en la VM
 * detrás de un rewrite de la landing, así que el `Host` que llega upstream es el
 * del contenedor. Una base URL derivada de la request armaría el redirect de
 * Google contra el host equivocado y la vuelta del OAuth caería en la nada. Por
 * eso `BETTER_AUTH_URL` es obligatoria y `trustedOrigins` sale de ella.
 *
 * ## Corrección al plan: el `baseURL` que recibe Better Auth **incluye** `/api/auth`
 *
 * El plan pide dos cosas que en Better Auth 1.7 no pueden ser ciertas a la vez:
 * `baseURL = https://…/admin` y el redirect URI en `https://…/admin/api/auth/
 * callback/google`. **Cuando el `baseURL` ya trae un path, `basePath` se
 * ignora** — `withPath()` corta en seco si la URL tiene pathname
 * (`node_modules/better-auth/dist/utils/url.mjs:42-49`) — y el router monta y
 * recorta usando ese path tal cual:
 * `const basePath = new URL(ctx.baseURL).pathname`
 * (`dist/api/index.mjs:152`). Con `baseURL = …/admin`, los endpoints quedarían
 * en `/admin/get-session` y el catch-all tendría que tragarse **todas** las
 * rutas del panel; verificado corriéndolo: `/admin/api/auth/get-session`
 * devolvía 404.
 *
 * Así que la variable de entorno sigue siendo la que dice el plan y el runbook
 * — la **raíz del panel** — y acá se le agrega `/api/auth` para armar el punto
 * de montaje. Con eso el redirect URI queda exactamente donde el plan lo pide,
 * que es lo que importa: es el que se registra en Google Cloud y el que no se
 * puede cambiar sin tocar la consola.
 */

// ── Entorno ─────────────────────────────────────────────────────────────────

/** Un entorno cualquiera. `process.env` encaja, y un objeto literal de test también. */
type Env = Record<string, string | undefined>;

function requireEnv(name: string, hint: string, env: Env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} no está definida. ${hint}`);
  return value;
}

/** 30 días deslizantes. Entrar tiene que ser raro; revocar, fácil. */
const SESSION_EXPIRES_IN = 60 * 60 * 24 * 30;

/**
 * Cada día de uso corre el vencimiento otros 30. Es lo que hace "deslizante" a
 * la sesión sin escribir en la base en cada request.
 */
const SESSION_UPDATE_AGE = 60 * 60 * 24;

/** Cómo aparece la cuenta en la app de autenticación de la técnica. */
const TOTP_ISSUER = "Golden Beauty Studio";

/**
 * La pantalla de entrada, relativa al `basePath` del panel. Vive acá y no en la
 * página porque la configuración de Better Auth también la necesita para mandar
 * ahí sus errores.
 */
export const LOGIN_PATH = "/entrar";

/**
 * Una URL absoluta dentro del panel, construida desde `BETTER_AUTH_URL`.
 *
 * Los `callbackURL` del flujo de OAuth se validan contra `trustedOrigins`, y
 * armarlos desde la misma variable que define esos orígenes hace imposible el
 * error de dejar uno apuntando al host del contenedor.
 */
export function panelUrl(path: string, env: Env = process.env): string {
  return `${panelRoot(env)}${path}`;
}

/** La raíz del panel, sin barra final. */
function panelRoot(env: Env): string {
  return requireEnv(
    "BETTER_AUTH_URL",
    "Es la URL pública del panel (https://goldenbeautystudio.com.co/admin). " +
      "Se fija a mano porque detrás del rewrite el Host upstream es el de la VM.",
    env,
  ).replace(/\/+$/, "");
}

/**
 * Dónde se montan los endpoints de Better Auth.
 *
 * Es la raíz del panel más `/api/auth`, y tiene que coincidir con la ruta del
 * catch-all (`app/(auth)/api/auth/[...all]`) y con el redirect URI registrado en
 * Google Cloud. Ver la corrección al plan en la cabecera de este archivo.
 */
export function authMountUrl(env: Env = process.env): string {
  return `${panelRoot(env)}/api/auth`;
}

/**
 * El `basePath` de Next, deducido de la misma variable.
 *
 * Es `/admin`, el mismo valor que `next.config.ts`, pero no se importa de ahí:
 * `next.config.ts` es de otro paquete y su valor se hornea en el build. Sacarlo
 * de `BETTER_AUTH_URL` deja **una** fuente para las dos cosas que tienen que
 * coincidir — la URL pública y el prefijo de las rutas.
 */
export function panelBasePath(env: Env = process.env): string {
  const path = new URL(panelRoot(env)).pathname.replace(/\/+$/, "");
  return path === "" || path === "/" ? "" : path;
}

// ── El plugin de entrada por TOTP ───────────────────────────────────────────

const signInTotpBody = z.object({
  /** El id del `user`, elegido tocando un nombre en la grilla del login. */
  userId: z.string().min(1).max(36),
  /** Seis dígitos. Se acepta con espacios: las apps los muestran así. */
  code: z.string().min(1).max(16),
});

/**
 * La fila de `staff_totp` como la quiere `totp.ts`: secreto descifrado y el
 * estado de la racha con sus nombres de dominio.
 *
 * `last_used_step` es `BIGINT` y el driver está en `supportBigNumbers`, así que
 * puede volver como cadena si algún día excediera el rango seguro de `Number`.
 * Un step son los segundos Unix divididos en 30 — no llega ni de lejos — pero
 * el `Number()` explícito hace que la comparación de la anti-repetición sea
 * numérica y no lexicográfica pase lo que pase.
 */
function toEnrollment(row: StaffTotp): TotpEnrollment {
  return {
    secret: decryptTotpSecret(Buffer.from(row.secret_encrypted), requireTotpEncKey()),
    confirmedAt: row.confirmed_at,
    state: {
      lastUsedStep:
        row.last_used_step === null ? null : Number(row.last_used_step),
      failedAttempts: row.failed_attempts,
      firstFailedAt: row.first_failed_at,
      lockedUntil: row.locked_until,
    },
  };
}

/**
 * Un fallo de login, siempre igual hacia afuera.
 *
 * Cuenta inexistente, sin enrolar, código incorrecto, código repetido: todos
 * responden lo mismo. La grilla del login ya muestra los nombres — el nombre
 * nunca fue el secreto — pero eso no es razón para además confirmar cuál de las
 * cuentas está enrolada o cuál código estuvo cerca.
 *
 * El bloqueo **sí** se distingue, y a propósito: una técnica bloqueada tiene que
 * saber que su camino es avisarle a la dueña, no seguir intentando.
 */
function invalidCode(): APIError {
  return new APIError("UNAUTHORIZED", {
    code: "TOTP_INVALIDO",
    message: "El código no es válido. Revisá la app y volvé a intentar.",
  });
}

function lockedOut(): APIError {
  return new APIError("FORBIDDEN", {
    code: "TOTP_BLOQUEADO",
    message:
      "Esta cuenta quedó bloqueada por intentos fallidos. La dueña la libera desde Equipo.",
  });
}

function staffTotpPlugin() {
  return {
    id: "gbs-staff-totp",

    endpoints: {
      /**
       * `POST /sign-in/totp` — el login de las técnicas.
       *
       * Verifica el código y crea la sesión. El orden importa y está fijado en
       * `totp.ts`: bloqueo, forma, ventana completa sin cortar, anti-repetición.
       */
      signInTotp: createAuthEndpoint(
        "/sign-in/totp",
        { method: "POST", body: signInTotpBody },
        async (ctx) => {
          const { userId, code } = ctx.body;
          const db = getDb();
          const totp = staffTotpRepository(db);

          const now = new Date();
          const row = await totp.findByUserId(userId);
          // La decisión es de `planTotpAttempt()`, en `totp.ts`, y está
          // testeada. Acá solo se traduce a escritura, sesión y código HTTP.
          const plan = planTotpAttempt({
            enrollment: row ? toEnrollment(row) : null,
            code,
            now,
          });

          if (plan.kind === "locked") throw lockedOut();
          if (plan.kind === "deny") {
            if (plan.failure) await totp.recordFailure(userId, plan.failure);
            throw invalidCode();
          }

          // El correo tiene que seguir en la allowlist. Sacar a alguien de la
          // lista y revocarle la sesión abierta son dos actos distintos (ver el
          // repositorio de A2); esto cierra el primero sin depender del segundo.
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) throw invalidCode();
          const allowlist = await allowedUserRepository(db).list();
          if (findAllowedEntry(user.email, allowlist) === null) throw invalidCode();

          await totp.recordSuccess(userId, plan.step);

          const session = await ctx.context.internalAdapter.createSession(userId);
          await setSessionCookie(ctx, { session, user });

          return ctx.json({ ok: true });
        },
      ),
    },

    /**
     * Tope de intentos por IP, encima del bloqueo por cuenta.
     *
     * El bloqueo de `staff_totp` protege **una** cuenta; esto protege a las
     * tres a la vez de alguien que recorra la grilla. Diez intentos por minuto
     * es holgado para una persona escribiendo seis dígitos con el pulgar.
     */
    rateLimit: [
      {
        pathMatcher: (path: string) => path === "/sign-in/totp",
        window: 60,
        max: 10,
      },
    ],
  };
}

// ── La instancia ────────────────────────────────────────────────────────────

function createAuth(env: Env = process.env) {
  const baseURL = authMountUrl(env);
  const workspaceDomain = requireEnv(
    "GOOGLE_WORKSPACE_DOMAIN",
    "Es el dominio de Workspace del estudio; se compara contra el claim `hd` " +
      "firmado del ID token. Sin dominio no hay compuerta.",
    env,
  );

  return betterAuth({
    appName: "gbs-admin",
    baseURL,
    secret: requireEnv(
      "BETTER_AUTH_SECRET",
      "Firma las cookies de sesión. `openssl rand -base64 32`.",
      env,
    ),

    // El origen del apex, no el del contenedor. Es lo que valida `callbackURL`
    // y el header `Origin` de las escrituras.
    trustedOrigins: [new URL(baseURL).origin],

    // El esquema ya existe (migración `001-better-auth`, paquete A2) con los
    // nombres de columna en camelCase que este adaptador espera. Nada de acá
    // crea tablas: las migraciones son de A2 y de nadie más.
    database: { db: getDb(), type: "mysql" },

    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
    },

    advanced: {
      // Sin `Domain`: el navegador la asocia al apex que la emitió. Con
      // `crossSubDomainCookies` la cookie del panel viajaría también a la
      // landing y a cualquier subdominio, que es exactamente lo que no
      // queremos de una cookie de sesión administrativa.
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        // El panel entero vive bajo `/admin`. Acotar el path hace que la
        // cookie no se mande en ninguna request de la landing. Sale de la
        // misma variable que el resto de las rutas, no de un literal repetido.
        path: panelBasePath(env) || "/",
      },
    },

    socialProviders: {
      google: {
        clientId: requireEnv(
          "GOOGLE_CLIENT_ID",
          "Sale del cliente OAuth del proyecto de Google Cloud (ver el runbook).",
          env,
        ),
        clientSecret: requireEnv(
          "GOOGLE_CLIENT_SECRET",
          "Sale del cliente OAuth del proyecto de Google Cloud (ver el runbook).",
          env,
        ),
        // Better Auth impone este dominio contra el claim `hd` **verificado**
        // del ID token, no contra el parámetro de la request
        // (`@better-auth/core/dist/social-providers/google.mjs:114,120`). Es la
        // primera compuerta; `validateUserInfo` la vuelve a comprobar abajo
        // junto con las otras dos, porque una compuerta que solo vive en la
        // configuración de una dependencia no tiene test propio.
        hd: workspaceDomain,
        // El panel no llama ninguna API de Google en nombre de la persona: no
        // hace falta refresh token, y no pedirlo es un secreto menos guardado.
        accessType: "online",
        prompt: "select_account",
      },
    },

    user: {
      /**
       * **La compuerta.** Corre antes de crear el usuario, antes de enlazar una
       * cuenta y en cada sign-in de OAuth, y recibe los claims frescos del
       * proveedor — no la fila guardada. Devolver `{ error }` rechaza: los
       * flujos de navegador terminan en la URL de error del panel.
       *
       * El caso no-OAuth es el enrolamiento de una técnica, que crea su `user`
       * desde Equipo con correo personal. Ahí las dos compuertas de Workspace
       * no aplican por definición, pero la allowlist sí: la dueña autoriza el
       * correo antes de enrolar a nadie.
       */
      validateUserInfo: async ({ user, source }) => {
        const allowlist = await allowedUserRepository(getDb()).list();

        if (source.method !== "oauth") {
          return findAllowedEntry(user.email, allowlist) === null
            ? { error: "acceso_denegado" }
            : undefined;
        }

        const decision = isAllowedIdentity(
          source.oauth?.profile ?? {},
          allowlist,
          workspaceDomain,
        );
        if (!decision.ok) {
          // El motivo va al log del servidor y nunca a la pantalla: a quien no
          // puede entrar no se le dice si su correo está o no en la lista.
          console.warn(
            `[auth] sign-in rechazado (${decision.reason}) para el proveedor ${source.oauth?.providerId ?? "?"}`,
          );
          return { error: "acceso_denegado" };
        }
        return undefined;
      },
    },

    // Cualquier fallo del flujo de OAuth que ocurra antes de que se pueda leer
    // el `errorCallbackURL` del state cae acá. Sin esto termina en
    // `/admin/api/auth/error`, una pantalla de la librería en inglés: la
    // recepcionista vería una página rota en vez de "esta cuenta no tiene
    // acceso" y llamaría por teléfono.
    onAPIError: { errorURL: panelUrl(LOGIN_PATH, env) },

    plugins: [
      staffTotpPlugin(),
      // Va último a propósito: su hook `after` copia los `Set-Cookie` que
      // dejaron los demás al almacén de cookies de Next, y solo puede copiar lo
      // que ya se escribió.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let singleton: Auth | null = null;

/**
 * La instancia compartida del proceso.
 *
 * Perezosa por la misma razón que `getDb()`: `next build` importa los módulos
 * para analizarlos y corre sin las variables del stack. Construir la instancia
 * en el import haría fallar el build en vez de fallar el arranque, que es
 * cuando el error significa algo.
 */
export function getAuth(): Auth {
  if (!singleton) singleton = createAuth();
  return singleton;
}

// ── Enrolamiento (lo llama Equipo, paquete C4) ──────────────────────────────

/**
 * Crea (o re-crea) el secreto TOTP de una técnica y devuelve el `otpauth://`.
 *
 * **Se muestra una sola vez.** Después de esto el secreto solo existe cifrado en
 * `staff_totp` y en el celular de la técnica; el panel no lo puede volver a
 * mostrar porque no lo puede volver a leer en claro sin descifrarlo, y no hay
 * pantalla que lo haga. Recuperar es re-enrolar: un QR nuevo en treinta
 * segundos resuelve más que un papel con códigos de respaldo que se pierde con
 * el mismo celular.
 *
 * Queda **sin confirmar**: hasta que la técnica mande un código válido
 * (`confirmStaffTotp`), la cuenta no entra.
 */
export async function enrollStaffTotp(params: {
  userId: string;
  /** Cómo se va a ver la cuenta en la app. El nombre de la técnica alcanza. */
  accountLabel: string;
}): Promise<{ otpauthUrl: string }> {
  const secret = generateTotpSecret();
  await staffTotpRepository(getDb()).enroll(
    params.userId,
    encryptTotpSecret(secret, requireTotpEncKey()),
  );
  return {
    otpauthUrl: buildOtpauthUrl({
      issuer: TOTP_ISSUER,
      account: params.accountLabel,
      secret,
    }),
  };
}

/**
 * Confirma el enrolamiento con el primer código.
 *
 * El step usado se consume igual que en un login: si el QR se mostró en una
 * pantalla que alguien más vio, ese código ya no sirve dos veces.
 */
export async function confirmStaffTotp(params: {
  userId: string;
  code: string;
}): Promise<boolean> {
  const totp = staffTotpRepository(getDb());
  const row = await totp.findByUserId(params.userId);
  if (!row) return false;

  const now = new Date();
  const state = {
    lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step),
    failedAttempts: row.failed_attempts,
    firstFailedAt: row.first_failed_at,
    lockedUntil: row.locked_until,
  };
  const verdict = verifyTotpCode({
    secret: decryptTotpSecret(Buffer.from(row.secret_encrypted), requireTotpEncKey()),
    code: params.code,
    now,
    state,
  });

  if (!verdict.ok) {
    if (verdict.reason !== "malformado" && verdict.reason !== "bloqueado") {
      await totp.recordFailure(params.userId, registerFailure(state, now));
    }
    return false;
  }

  await totp.confirm(params.userId, now, verdict.step);
  return true;
}

// ── La grilla del login ─────────────────────────────────────────────────────

export type TotpLoginCandidate = {
  userId: string;
  name: string;
  /** `true` mientras la dueña no la haya soltado desde Equipo. */
  locked: boolean;
};

/**
 * Quiénes aparecen en la grilla de nombres del login.
 *
 * Solo cuentas con enrolamiento **confirmado** y con fila en `allowed_user`. La
 * grilla existe porque el estudio tiene tres personas y escribir un correo en
 * un celular entre dos clientas es más lento que tocar un nombre; el nombre
 * nunca fue el secreto, el código sí.
 *
 * Se devuelve `locked` para poder decirle a la técnica que su cuenta está
 * bloqueada **antes** de que escriba seis dígitos que van a fallar igual.
 */
export async function listTotpLoginCandidates(
  now: Date = new Date(),
): Promise<TotpLoginCandidate[]> {
  const db = getDb();
  const rows = await db
    .selectFrom("staff_totp")
    .innerJoin("user", "user.id", "staff_totp.user_id")
    .select([
      "staff_totp.user_id as userId",
      "user.name as name",
      "user.email as email",
      "staff_totp.locked_until as lockedUntil",
    ])
    .where("staff_totp.confirmed_at", "is not", null)
    .orderBy("user.name")
    .execute();

  const allowlist: AllowedIdentity[] = await allowedUserRepository(db).list();

  return rows
    .filter((row) => findAllowedEntry(row.email, allowlist) !== null)
    .map((row) => ({
      userId: row.userId,
      name: row.name,
      locked: row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime(),
    }));
}
