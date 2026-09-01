/**
 * TOTP como **factor primario** de las técnicas.
 *
 * Las técnicas del estudio usan correo personal, así que la compuerta de
 * Workspace las deja afuera por diseño. Su entrada es un código de seis dígitos
 * desde la app de autenticación de su celular: sin contraseña, sin correo
 * corporativo, sin una silla de licencia por persona.
 *
 * ## Por qué esto está escrito a mano
 *
 * El plugin de dos factores de Better Auth **no sirve acá**. Es explícitamente
 * un *segundo* factor: `/two-factor/enable` corre detrás de `sessionMiddleware`
 * y `verifyTwoFactor()` exige una sesión ya iniciada o la cookie que deja un
 * primer factor recién validado (`node_modules/better-auth/dist/plugins/
 * two-factor/verify-two-factor.mjs`, líneas 13–22). Sin primer factor no hay
 * nada que verificar. Así que el login de las técnicas es una ruta propia que
 * verifica el código y crea la sesión con la API de servidor — y por eso este
 * archivo entra completo a la capa 1 de tests, con los casos negativos primero.
 *
 * ## Se dice claro: TOTP solo es un factor, no dos
 *
 * Lo que lo hace aceptable es el **alcance**. Una sesión `staff` alcanza su
 * propio día, sus propias cuentas y su propia liquidación, y nada más — nunca
 * la caja, ni los reportes, ni las demás (ver la matriz en `auth-policy.ts`).
 * La compuerta fuerte sigue siendo Workspace, y protege lo que importa.
 *
 * ## Lo que este archivo decide y lo que no
 *
 * Todo lo de acá es puro salvo el cifrado, que usa `node:crypto`. El reloj
 * entra como parámetro (`now`), el estado de la fila entra como parámetro, y lo
 * que sale es una decisión y el estado siguiente. Escribir la fila es del
 * repositorio (`db/repositories/staff-totp.ts`); componer las dos cosas es de
 * `auth.ts`.
 *
 * Implementa RFC 6238 sobre RFC 4226 con HMAC-SHA1, que es lo que generan
 * Google Authenticator, Authy y 1Password cuando leen un `otpauth://totp/`.
 * SHA-1 acá no es una debilidad: HOTP no depende de la resistencia a colisiones
 * de la función, y un secreto distinto por persona hace irrelevante el ataque
 * que sí importaría.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// ── Parámetros. Ninguno es negociable en una llamada ────────────────────────

/** Seis dígitos: lo que muestra cualquier app de autenticación. */
export const TOTP_DIGITS = 6;

/** Un código vive 30 segundos. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Tolerancia de **±1 step, ni uno más**.
 *
 * Un step de gracia cubre el desfase real de un celular y el tiempo que tarda
 * alguien en escribir seis dígitos. Dos ya son noventa segundos de ventana
 * viva, que es tiempo de sobra para que un código leído por encima del hombro
 * siga sirviendo.
 */
export const TOTP_SKEW_STEPS = 1;

/** Cinco fallos dentro de la ventana y la cuenta queda bloqueada. */
export const MAX_FAILED_ATTEMPTS = 5;

/**
 * La ventana del bloqueo: quince minutos.
 *
 * Es una **ventana**, y por eso `staff_totp` tiene `first_failed_at`. Un
 * contador solo no puede expresarla: cinco errores de dedo repartidos a lo
 * largo de un mes bloquearían a alguien que simplemente escribe mal de vez en
 * cuando.
 */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * El bloqueo **no vence solo**: la cuenta queda bloqueada hasta que la dueña la
 * suelte desde Equipo. `locked_until` se escribe con una fecha lejana en vez de
 * con `NULL` para que la columna signifique siempre lo mismo — "bloqueada hasta
 * este instante" — y para que la consulta de Equipo (`idx_totp_locked`) no
 * necesite dos casos.
 *
 * Cien años. No es una fecha bonita, es una que ningún reloj mal puesto alcanza.
 */
export const LOCK_FOREVER_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Bytes de secreto: 160 bits, el tamaño que recomienda el RFC 4226 §4 R6. */
const SECRET_BYTES = 20;

// ── Base32 (RFC 4648, sin relleno) ──────────────────────────────────────────

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Base32 sin `=` de relleno.
 *
 * Es el formato del parámetro `secret` de un `otpauth://`, y las apps de
 * autenticación lo esperan en mayúsculas y sin relleno. Se escribe a mano
 * porque `node:buffer` no trae base32 y una dependencia de cuatro líneas para
 * esto es una dependencia de más en la ruta de login.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decodifica base32. Devuelve `null` ante cualquier carácter que no pertenezca
 * al alfabeto, en vez de ignorarlo: un secreto mal transcrito tiene que fallar
 * al enrolarse, no producir un secreto distinto que nunca va a validar.
 *
 * Acepta relleno y minúsculas porque un ser humano puede pegar el secreto a
 * mano en Equipo cuando la cámara no lee el QR.
 */
export function base32Decode(text: string): Buffer | null {
  // El orden importa: primero se quitan los espacios y recién después el
  // relleno. Al revés, un `MZXW6YTBOI== ` con un espacio al final conserva los
  // `=` y el decodificador los toma por caracteres inválidos.
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  if (clean === "") return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of clean) {
    const value = B32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// ── Generación de códigos ───────────────────────────────────────────────────

/** El step de TOTP para un instante: segundos Unix dividido en el periodo. */
export function stepAt(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * HOTP (RFC 4226): HMAC-SHA1 del contador de 8 bytes big-endian, truncamiento
 * dinámico, módulo 10^6, rellenado con ceros a la izquierda.
 */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", secret).update(message).digest();
  // El truncamiento dinámico del RFC: los 4 bits bajos del último byte dicen
  // desde dónde leer los 4 bytes que se usan.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** El código que la app del celular muestra en ese instante. */
export function totpAt(secret: Buffer, atMs: number): string {
  return hotp(secret, stepAt(atMs));
}

/**
 * La URL que se convierte en QR al enrolar.
 *
 * Se muestra **una sola vez**: después de eso el secreto solo existe cifrado en
 * la base y en el celular de la técnica. Recuperar es re-enrolar — nada de
 * códigos de respaldo impresos, que se pierden con el mismo celular que se
 * perdió.
 *
 * `issuer` va en el path *y* en el query porque las apps no coinciden en cuál
 * leen, y con solo uno de los dos la entrada aparece sin nombre o duplicada.
 */
export function buildOtpauthUrl(params: {
  issuer: string;
  /** Cómo aparece la cuenta en la app. El nombre de la técnica alcanza. */
  account: string;
  secret: Buffer;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Un secreto nuevo. Se genera al enrolar y no se vuelve a mostrar. */
export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

// ── Cifrado en reposo ───────────────────────────────────────────────────────

/**
 * `secret_encrypted` es `VARBINARY` y **nunca** guarda el secreto en claro.
 *
 * AES-256-GCM con un IV nuevo por escritura. El formato del blob es
 * `[iv(12) | tag(16) | ciphertext(20)]` = 48 bytes: concatenado y no JSON,
 * porque una columna binaria con JSON adentro invita a que alguien la lea con
 * un `SELECT` y la copie a un log.
 *
 * GCM y no CBC porque el mensaje autenticado importa: si alguien con acceso de
 * escritura a la base cambia un byte del ciphertext, el descifrado **falla** en
 * vez de producir un secreto distinto que nadie puede explicar.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Lee `TOTP_ENC_KEY` y devuelve los 32 bytes de la llave.
 *
 * Acepta base64 o hex — quien la genere va a usar `openssl rand -base64 32` o
 * `-hex 32`, y obligar a uno de los dos solo garantiza un despliegue fallido a
 * las dos de la mañana. Lo que no se acepta es una llave del largo equivocado:
 * una passphrase corta estirada en silencio sería cifrado de mentira.
 */
export function requireTotpEncKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env.TOTP_ENC_KEY;
  if (!raw) {
    throw new Error(
      "TOTP_ENC_KEY no está definida. Son 32 bytes en base64 o hex " +
        "(`openssl rand -base64 32`) y cifran el secreto TOTP de cada técnica " +
        "en reposo. Sin ella el panel no arranca, y eso es correcto.",
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENC_KEY mide ${key.length} bytes y tiene que medir 32 ` +
        "(base64 o hex de 32 bytes). Una llave más corta no se estira: se rechaza.",
    );
  }
  return key;
}

export function encryptTotpSecret(secret: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Descifra el blob de `secret_encrypted`.
 *
 * Lanza si el blob está truncado o si el tag no valida. No devuelve `null`: un
 * secreto ilegible no es "código incorrecto", es una fila corrupta o una llave
 * rotada sin re-enrolar, y confundir las dos cosas haría que la técnica viera
 * "código incorrecto" para siempre sin que nadie mirara la base.
 */
export function decryptTotpSecret(blob: Buffer, key: Buffer): Buffer {
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("El blob de secret_encrypted está truncado.");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Verificación ────────────────────────────────────────────────────────────

/**
 * El estado de bloqueo y anti-repetición que vive en la fila `staff_totp`.
 * Se recibe y se devuelve; esta capa no escribe.
 */
export type TotpAttemptState = {
  /** El último step **aceptado**. `null` mientras la técnica no haya entrado. */
  lastUsedStep: number | null;
  failedAttempts: number;
  firstFailedAt: Date | null;
  lockedUntil: Date | null;
};

export type TotpRejection =
  /** No son seis dígitos. Ni se calcula HMAC: no hay nada que comparar. */
  | "malformado"
  /** El código no corresponde a ningún step de la ventana. */
  | "incorrecto"
  /**
   * El código es correcto pero su step ya se consumió. **Es la anti-repetición**,
   * y es obligatoria: un código vive 30 segundos y alguien que lo vea por encima
   * del hombro podría reusarlo dentro de esa ventana.
   */
  | "repetido"
  /** La cuenta está bloqueada; solo la dueña la suelta. */
  | "bloqueado";

export type TotpVerification =
  | { ok: true; step: number }
  | { ok: false; reason: TotpRejection };

/** ¿La cuenta está bloqueada en este instante? */
export function isLocked(state: TotpAttemptState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * Normaliza lo que la técnica escribió.
 *
 * Espacios adentro y alrededor porque las apps muestran `123 456` y la gente lo
 * copia tal cual. Devuelve `null` si no quedan exactamente seis dígitos: eso
 * hace que **todos** los códigos que llegan a la comparación midan lo mismo,
 * que es la precondición de `timingSafeEqual`.
 */
function normalizeCode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * Comparación en **tiempo constante**.
 *
 * `timingSafeEqual` exige buffers del mismo largo, y por eso el código ya viene
 * normalizado a seis dígitos. Un `===` de strings corta en el primer carácter
 * distinto: con suficientes intentos, el tiempo de respuesta dice cuántos
 * dígitos iniciales acertaste. Con seis dígitos y bloqueo a los cinco fallos el
 * ataque es teórico, pero el costo de hacerlo bien es una línea.
 *
 * La guarda de largo es la que `timingSafeEqual` exige — lanza si los buffers
 * no miden lo mismo. Acá no puede pasar, porque los dos lados son seis dígitos
 * por construcción; se exporta igual para que ese contrato tenga su test y no
 * sea una rama que nadie ejercitó nunca.
 */
export function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifica un código contra el secreto y el estado de la fila.
 *
 * El orden de los chequeos es deliberado:
 *
 * 1. **Bloqueo primero.** Una cuenta bloqueada no gasta un HMAC ni revela nada
 *    por el tiempo de respuesta.
 * 2. **Forma después.** Sin seis dígitos no hay nada que comparar, y devolver
 *    "incorrecto" ahí gastaría un intento de los cinco por un error de dedo que
 *    ni siquiera llegó a ser un intento.
 * 3. **La ventana completa, sin cortar.** Se prueban los tres steps (−1, 0, +1)
 *    y se acumula el resultado sin `break`: salir temprano en el que acierta
 *    filtra por tiempo *cuál* de los tres era.
 * 4. **Anti-repetición al final**, sobre el step que acertó.
 *
 * Se rechaza un step **menor o igual** al último aceptado, no solo el igual: si
 * alguien ya entró con el código de las 10:00:30, el de las 10:00:00 sigue
 * dentro de la tolerancia y es exactamente el que un mirón tendría anotado.
 */
export function verifyTotpCode(params: {
  secret: Buffer;
  code: string;
  now: Date;
  state: TotpAttemptState;
}): TotpVerification {
  const { secret, code, now, state } = params;

  if (isLocked(state, now)) return { ok: false, reason: "bloqueado" };

  const normalized = normalizeCode(code);
  if (normalized === null) return { ok: false, reason: "malformado" };

  const current = stepAt(now.getTime());
  let matched: number | null = null;

  for (let delta = -TOTP_SKEW_STEPS; delta <= TOTP_SKEW_STEPS; delta += 1) {
    const candidate = current + delta;
    // Sin `break`: se recorre siempre la ventana entera.
    if (equalsConstantTime(hotp(secret, candidate), normalized)) {
      matched = candidate;
    }
  }

  if (matched === null) return { ok: false, reason: "incorrecto" };

  if (state.lastUsedStep !== null && matched <= state.lastUsedStep) {
    return { ok: false, reason: "repetido" };
  }

  return { ok: true, step: matched };
}

/**
 * El estado siguiente después de un fallo que **sí cuenta**.
 *
 * La racha se reinicia cuando el fallo anterior quedó fuera de la ventana de
 * quince minutos. Al llegar a cinco dentro de la ventana, la cuenta queda
 * bloqueada hasta que la dueña la suelte — no hasta que pase un rato. Un
 * bloqueo que se vence solo le devuelve al atacante cinco intentos nuevos cada
 * cuarto de hora, que sobre seis dígitos es un presupuesto que eventualmente
 * alcanza.
 *
 * Un intento `malformado` no llega acá: no fue un intento, fue un error de
 * dedo. Un intento `repetido` **sí**, porque un código correcto reenviado es
 * justo lo que hace un ataque de repetición.
 */
export function registerFailure(
  state: TotpAttemptState,
  now: Date,
): { failedAttempts: number; firstFailedAt: Date; lockedUntil: Date | null } {
  const streakStart = state.firstFailedAt;
  const withinWindow =
    streakStart !== null &&
    now.getTime() - streakStart.getTime() < FAILURE_WINDOW_MS;

  const firstFailedAt = withinWindow ? streakStart : now;
  const failedAttempts = withinWindow ? state.failedAttempts + 1 : 1;
  const lockedUntil =
    failedAttempts >= MAX_FAILED_ATTEMPTS
      ? new Date(now.getTime() + LOCK_FOREVER_MS)
      : null;

  return { failedAttempts, firstFailedAt, lockedUntil };
}

// ── El intento completo ─────────────────────────────────────────────────────

/**
 * El enrolamiento tal como sale de `staff_totp`, con el secreto ya descifrado.
 *
 * `confirmedAt` es `null` mientras la técnica no haya confirmado el QR: hasta
 * entonces la cuenta no entra.
 */
export type TotpEnrollment = {
  secret: Buffer;
  confirmedAt: Date | null;
  state: TotpAttemptState;
};

export type TotpAttemptPlan =
  /** Adentro. Hay que consumir el step y crear la sesión. */
  | { kind: "allow"; step: number }
  /** Afuera, y la cuenta sigue bloqueada hasta que la dueña la suelte. */
  | { kind: "locked" }
  /**
   * Afuera. `failure` es el estado nuevo de la racha, o `null` cuando el intento
   * no llegó a contar.
   */
  | {
      kind: "deny";
      reason: TotpRejection;
      failure: {
        failedAttempts: number;
        firstFailedAt: Date;
        lockedUntil: Date | null;
      } | null;
    };

/**
 * La decisión completa de un intento de entrada, en una sola función pura.
 *
 * Existe por la misma regla que saca los cálculos de plata de los handlers:
 * "sin fila no hay cuenta", "un código malformado no gasta intento", "un código
 * repetido sí" y "un bloqueo se contesta distinto" son **decisiones**, y una
 * decisión dentro de un `if` de un endpoint solo se puede verificar a mano. Acá
 * entra el estado y sale qué hacer; el endpoint de `auth.ts` traduce esa
 * respuesta a una escritura, una sesión y un código HTTP, y nada más.
 */
export function planTotpAttempt(params: {
  enrollment: TotpEnrollment | null;
  code: string;
  now: Date;
}): TotpAttemptPlan {
  const { enrollment, code, now } = params;

  // Sin fila, o con el QR sin confirmar, la cuenta no existe para el login. No
  // se registra fallo: no hay racha que llevar sobre una cuenta que nunca
  // entró, y llevarla dejaría "bloquear" a alguien que todavía no se enroló.
  if (!enrollment || enrollment.confirmedAt === null) {
    return { kind: "deny", reason: "incorrecto", failure: null };
  }

  const verdict = verifyTotpCode({
    secret: enrollment.secret,
    code,
    now,
    state: enrollment.state,
  });

  if (verdict.ok) return { kind: "allow", step: verdict.step };
  if (verdict.reason === "bloqueado") return { kind: "locked" };

  // Un `malformado` no gasta intento: no llegó a ser un intento, fue un error
  // de dedo. Un `repetido` sí — un código correcto reenviado es exactamente la
  // forma de un ataque de repetición.
  return {
    kind: "deny",
    reason: verdict.reason,
    failure:
      verdict.reason === "malformado"
        ? null
        : registerFailure(enrollment.state, now),
  };
}
