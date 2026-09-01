import { describe, expect, it } from "vitest";

import {
  FAILURE_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  decryptTotpSecret,
  encryptTotpSecret,
  equalsConstantTime,
  generateTotpSecret,
  hotp,
  isLocked,
  planTotpAttempt,
  registerFailure,
  requireTotpEncKey,
  stepAt,
  totpAt,
  verifyTotpCode,
  type TotpAttemptState,
} from "./totp";

/**
 * Es la puerta de entrada de las técnicas y está escrita a mano. Se testea como
 * tal: los rechazos primero, y los vectores del RFC para que no sea "lo que el
 * código hace" sino "lo que TOTP es".
 */

const KEY = Buffer.alloc(32, 7);

/** El secreto de los vectores de prueba del RFC 6238 (`"12345678901234567890"`). */
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

const LIMPIO: TotpAttemptState = {
  lastUsedStep: null,
  failedAttempts: 0,
  firstFailedAt: null,
  lockedUntil: null,
};

/** Un instante cualquiera, en el medio de su ventana de 30 s. */
const AHORA = new Date("2026-08-31T15:20:15.000Z");

function codeFor(atMs: number): string {
  return totpAt(RFC_SECRET, atMs);
}

// ── Rechazos ────────────────────────────────────────────────────────────────

describe("verifyTotpCode — lo que NO pasa", () => {
  it("rechaza un código de la ventana anterior cuyo step ya se consumió", () => {
    // La anti-repetición, que es el motivo por el que `last_used_step` existe:
    // un código vive 30 segundos y alguien que lo vea por encima del hombro
    // podría reusarlo dentro de la ventana.
    const step = stepAt(AHORA.getTime());
    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: codeFor(AHORA.getTime()),
      now: AHORA,
      state: { ...LIMPIO, lastUsedStep: step },
    });
    expect(verdict).toEqual({ ok: false, reason: "repetido" });
  });

  it("rechaza el código del step anterior aunque nunca se haya usado, si ya se usó uno posterior", () => {
    // El caso del mirón: entró con el de las 10:00:30, y el de las 10:00:00
    // sigue dentro de la tolerancia. Por eso se rechaza `<=`, no solo `===`.
    const step = stepAt(AHORA.getTime());
    const anterior = codeFor(AHORA.getTime() - 30_000);
    expect(
      verifyTotpCode({
        secret: RFC_SECRET,
        code: anterior,
        now: AHORA,
        state: { ...LIMPIO, lastUsedStep: step },
      }),
    ).toEqual({ ok: false, reason: "repetido" });
  });

  it("rechaza un skew de ±2 steps", () => {
    for (const delta of [-2, 2]) {
      expect(
        verifyTotpCode({
          secret: RFC_SECRET,
          code: codeFor(AHORA.getTime() + delta * 30_000),
          now: AHORA,
          state: LIMPIO,
        }),
      ).toEqual({ ok: false, reason: "incorrecto" });
    }
  });

  it("rechaza un código que no son seis dígitos sin gastar un intento", () => {
    for (const malo of ["", "12345", "1234567", "abcdef", "12 34 5", "  "]) {
      expect(
        verifyTotpCode({ secret: RFC_SECRET, code: malo, now: AHORA, state: LIMPIO }),
      ).toEqual({ ok: false, reason: "malformado" });
    }
  });

  it("rechaza un código de otro secreto", () => {
    expect(
      verifyTotpCode({
        secret: RFC_SECRET,
        code: totpAt(Buffer.from("otro-secreto-distinto", "ascii"), AHORA.getTime()),
        now: AHORA,
        state: LIMPIO,
      }),
    ).toEqual({ ok: false, reason: "incorrecto" });
  });

  it("rechaza todo mientras la cuenta esté bloqueada, incluso el código correcto", () => {
    const state: TotpAttemptState = {
      ...LIMPIO,
      lockedUntil: new Date(AHORA.getTime() + 60_000),
    };
    expect(
      verifyTotpCode({
        secret: RFC_SECRET,
        code: codeFor(AHORA.getTime()),
        now: AHORA,
        state,
      }),
    ).toEqual({ ok: false, reason: "bloqueado" });
  });
});

// ── Aceptaciones ────────────────────────────────────────────────────────────

describe("verifyTotpCode — lo que sí pasa", () => {
  it("acepta el código de la ventana actual y devuelve su step", () => {
    const verdict = verifyTotpCode({
      secret: RFC_SECRET,
      code: codeFor(AHORA.getTime()),
      now: AHORA,
      state: LIMPIO,
    });
    expect(verdict).toEqual({ ok: true, step: stepAt(AHORA.getTime()) });
  });

  it("tolera ±1 step, y solo uno", () => {
    for (const delta of [-1, 0, 1]) {
      const verdict = verifyTotpCode({
        secret: RFC_SECRET,
        code: codeFor(AHORA.getTime() + delta * 30_000),
        now: AHORA,
        state: LIMPIO,
      });
      expect(verdict).toEqual({ ok: true, step: stepAt(AHORA.getTime()) + delta });
    }
  });

  it("acepta el código escrito con los espacios que muestra la app", () => {
    const code = codeFor(AHORA.getTime());
    const conEspacios = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(
      verifyTotpCode({
        secret: RFC_SECRET,
        code: ` ${conEspacios} `,
        now: AHORA,
        state: LIMPIO,
      }).ok,
    ).toBe(true);
  });

  it("un bloqueo ya vencido deja de bloquear", () => {
    const state: TotpAttemptState = {
      ...LIMPIO,
      lockedUntil: new Date(AHORA.getTime() - 1),
    };
    expect(isLocked(state, AHORA)).toBe(false);
    expect(
      verifyTotpCode({
        secret: RFC_SECRET,
        code: codeFor(AHORA.getTime()),
        now: AHORA,
        state,
      }).ok,
    ).toBe(true);
  });

  it("sin lockedUntil no hay bloqueo", () => {
    expect(isLocked(LIMPIO, AHORA)).toBe(false);
  });
});

// ── El bloqueo por ventana ──────────────────────────────────────────────────

describe("registerFailure — 5 fallos en 15 minutos", () => {
  it("bloquea al quinto fallo dentro de la ventana", () => {
    let state: TotpAttemptState = { ...LIMPIO };
    let now = new Date("2026-08-31T10:00:00.000Z");

    for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i += 1) {
      const next = registerFailure(state, now);
      expect(next.failedAttempts).toBe(i);
      state = { ...state, ...next, firstFailedAt: next.firstFailedAt };
      // Un minuto entre intentos: los cinco caben en la ventana.
      now = new Date(now.getTime() + 60_000);
    }

    expect(state.lockedUntil).not.toBeNull();
    expect(isLocked(state, now)).toBe(true);
  });

  it("no bloquea con cuatro fallos", () => {
    let state: TotpAttemptState = { ...LIMPIO };
    let now = new Date("2026-08-31T10:00:00.000Z");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
      const next = registerFailure(state, now);
      state = { ...state, ...next };
      now = new Date(now.getTime() + 60_000);
    }
    expect(state.failedAttempts).toBe(MAX_FAILED_ATTEMPTS - 1);
    expect(state.lockedUntil).toBeNull();
  });

  it("reinicia la racha cuando el primer fallo quedó fuera de la ventana", () => {
    // Cuatro errores de dedo repartidos a lo largo de un mes no bloquean a
    // nadie. Es exactamente para esto que `first_failed_at` existe.
    const inicio = new Date("2026-08-31T10:00:00.000Z");
    const state: TotpAttemptState = {
      ...LIMPIO,
      failedAttempts: 4,
      firstFailedAt: inicio,
    };
    const tarde = new Date(inicio.getTime() + FAILURE_WINDOW_MS + 1);
    const next = registerFailure(state, tarde);

    expect(next.failedAttempts).toBe(1);
    expect(next.firstFailedAt).toEqual(tarde);
    expect(next.lockedUntil).toBeNull();
  });

  it("el borde exacto de la ventana todavía cuenta como fuera", () => {
    const inicio = new Date("2026-08-31T10:00:00.000Z");
    const justo = new Date(inicio.getTime() + FAILURE_WINDOW_MS);
    const next = registerFailure(
      { ...LIMPIO, failedAttempts: 4, firstFailedAt: inicio },
      justo,
    );
    expect(next.failedAttempts).toBe(1);
  });

  it("el bloqueo no se vence solo: lo suelta la dueña", () => {
    const now = new Date("2026-08-31T10:00:00.000Z");
    const next = registerFailure(
      { ...LIMPIO, failedAttempts: 4, firstFailedAt: now },
      now,
    );
    expect(next.lockedUntil).not.toBeNull();
    // Un año después sigue bloqueada. Un bloqueo que caduca le devuelve al
    // atacante cinco intentos nuevos cada cuarto de hora.
    const unAnioDespues = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(isLocked({ ...LIMPIO, ...next }, unAnioDespues)).toBe(true);
  });
});

// ── El intento completo ─────────────────────────────────────────────────────

describe("planTotpAttempt", () => {
  function enrolada(over: Partial<TotpAttemptState> = {}) {
    return {
      secret: RFC_SECRET,
      confirmedAt: new Date("2026-01-01T00:00:00.000Z"),
      state: { ...LIMPIO, ...over },
    };
  }

  it("sin fila, niega sin registrar fallo", () => {
    // No hay racha que llevar sobre una cuenta que nunca entró, y llevarla
    // dejaría "bloquear" a alguien que todavía no se enroló.
    expect(
      planTotpAttempt({ enrollment: null, code: codeFor(AHORA.getTime()), now: AHORA }),
    ).toEqual({ kind: "deny", reason: "incorrecto", failure: null });
  });

  it("con el QR sin confirmar, niega igual que un código equivocado", () => {
    expect(
      planTotpAttempt({
        enrollment: { ...enrolada(), confirmedAt: null },
        code: codeFor(AHORA.getTime()),
        now: AHORA,
      }),
    ).toEqual({ kind: "deny", reason: "incorrecto", failure: null });
  });

  it("un código malformado no gasta intento", () => {
    const plan = planTotpAttempt({ enrollment: enrolada(), code: "12", now: AHORA });
    expect(plan).toEqual({ kind: "deny", reason: "malformado", failure: null });
  });

  it("un código incorrecto sí gasta intento", () => {
    const plan = planTotpAttempt({
      enrollment: enrolada(),
      code: "000000",
      now: AHORA,
    });
    expect(plan.kind).toBe("deny");
    if (plan.kind !== "deny") throw new Error("inalcanzable");
    expect(plan.reason).toBe("incorrecto");
    expect(plan.failure).toEqual({
      failedAttempts: 1,
      firstFailedAt: AHORA,
      lockedUntil: null,
    });
  });

  it("un código repetido gasta intento: es la forma de un ataque de repetición", () => {
    const step = stepAt(AHORA.getTime());
    const plan = planTotpAttempt({
      enrollment: enrolada({ lastUsedStep: step }),
      code: codeFor(AHORA.getTime()),
      now: AHORA,
    });
    expect(plan.kind).toBe("deny");
    if (plan.kind !== "deny") throw new Error("inalcanzable");
    expect(plan.reason).toBe("repetido");
    expect(plan.failure?.failedAttempts).toBe(1);
  });

  it("el quinto fallo devuelve el bloqueo listo para escribir", () => {
    const plan = planTotpAttempt({
      enrollment: enrolada({ failedAttempts: 4, firstFailedAt: AHORA }),
      code: "000000",
      now: AHORA,
    });
    if (plan.kind !== "deny") throw new Error("inalcanzable");
    expect(plan.failure?.failedAttempts).toBe(5);
    expect(plan.failure?.lockedUntil).not.toBeNull();
  });

  it("una cuenta bloqueada se contesta distinto y no gasta intento", () => {
    expect(
      planTotpAttempt({
        enrollment: enrolada({ lockedUntil: new Date(AHORA.getTime() + 1000) }),
        code: codeFor(AHORA.getTime()),
        now: AHORA,
      }),
    ).toEqual({ kind: "locked" });
  });

  it("con el código correcto deja entrar y dice qué step consumir", () => {
    expect(
      planTotpAttempt({
        enrollment: enrolada(),
        code: codeFor(AHORA.getTime()),
        now: AHORA,
      }),
    ).toEqual({ kind: "allow", step: stepAt(AHORA.getTime()) });
  });
});

// ── HOTP / TOTP contra el RFC ───────────────────────────────────────────────

describe("hotp — vectores del RFC 4226 apéndice D", () => {
  const ESPERADOS = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it.each(ESPERADOS.map((code, counter) => [counter, code] as const))(
    "counter %i → %s",
    (counter, code) => {
      expect(hotp(RFC_SECRET, counter)).toBe(code);
    },
  );
});

describe("totpAt — vectores del RFC 6238 (SHA-1)", () => {
  // Los vectores del RFC son de 8 dígitos; acá se comparan los últimos 6, que
  // es lo que el truncamiento a `TOTP_DIGITS` produce.
  const CASOS: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];

  it.each(CASOS)("t=%i", (seconds, ocho) => {
    expect(totpAt(RFC_SECRET, seconds * 1000)).toBe(ocho.slice(-6));
  });

  it("el step cambia cada 30 segundos", () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(29_999)).toBe(0);
    expect(stepAt(30_000)).toBe(1);
  });
});

// ── Base32 y el QR ──────────────────────────────────────────────────────────

describe("base32", () => {
  it("va y vuelve", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(base32Encode(secret))?.equals(secret)).toBe(true);
  });

  it("codifica los vectores del RFC 4648", () => {
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
    expect(base32Encode(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("acepta relleno, minúsculas y espacios al decodificar", () => {
    expect(base32Decode(" mzxw 6ytb oi== ")?.toString()).toBe("foobar");
  });

  it("devuelve null ante un carácter que no está en el alfabeto", () => {
    // Un secreto mal transcrito tiene que fallar al enrolarse, no producir un
    // secreto distinto que nunca va a validar.
    expect(base32Decode("MZXW6YTB01")).toBeNull();
    expect(base32Decode("")).toBeNull();
    expect(base32Decode("   ")).toBeNull();
  });
});

describe("buildOtpauthUrl", () => {
  it("arma una URL que una app de autenticación entiende", () => {
    const url = new URL(
      buildOtpauthUrl({
        issuer: "Golden Beauty Studio",
        account: "Lina",
        secret: RFC_SECRET,
      }),
    );
    expect(url.protocol).toBe("otpauth:");
    expect(decodeURIComponent(url.pathname)).toContain("Golden Beauty Studio:Lina");
    expect(url.searchParams.get("secret")).toBe(base32Encode(RFC_SECRET));
    expect(url.searchParams.get("issuer")).toBe("Golden Beauty Studio");
    expect(url.searchParams.get("algorithm")).toBe("SHA1");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
  });

  it("escapa un nombre con caracteres que romperían la etiqueta", () => {
    const url = buildOtpauthUrl({
      issuer: "Golden/Beauty",
      account: "Ana María",
      secret: RFC_SECRET,
    });
    expect(url).toContain("Golden%2FBeauty");
    expect(url).toContain("Ana%20Mar%C3%ADa");
  });

  it("genera secretos de 20 bytes y distintos cada vez", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });
});

// ── Cifrado en reposo ───────────────────────────────────────────────────────

describe("cifrado del secreto", () => {
  it("va y vuelve", () => {
    const secret = generateTotpSecret();
    const blob = encryptTotpSecret(secret, KEY);
    expect(decryptTotpSecret(blob, KEY).equals(secret)).toBe(true);
  });

  it("nunca guarda el secreto en claro", () => {
    const secret = generateTotpSecret();
    const blob = encryptTotpSecret(secret, KEY);
    expect(blob.includes(secret)).toBe(false);
  });

  it("usa un IV nuevo por escritura", () => {
    const secret = generateTotpSecret();
    expect(
      encryptTotpSecret(secret, KEY).equals(encryptTotpSecret(secret, KEY)),
    ).toBe(false);
  });

  it("falla si alguien manipuló el ciphertext", () => {
    // GCM y no CBC justamente por esto: un byte cambiado revienta en vez de
    // producir un secreto distinto que nadie puede explicar.
    const blob = encryptTotpSecret(generateTotpSecret(), KEY);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptTotpSecret(blob, KEY)).toThrow();
  });

  it("falla con la llave equivocada", () => {
    const blob = encryptTotpSecret(generateTotpSecret(), KEY);
    expect(() => decryptTotpSecret(blob, Buffer.alloc(32, 9))).toThrow();
  });

  it("falla ante un blob truncado", () => {
    expect(() => decryptTotpSecret(Buffer.alloc(20), KEY)).toThrow(/truncado/);
  });
});

describe("equalsConstantTime", () => {
  it("es verdadera para cadenas iguales", () => {
    expect(equalsConstantTime("123456", "123456")).toBe(true);
  });

  it("es falsa para cadenas distintas del mismo largo", () => {
    expect(equalsConstantTime("123456", "123457")).toBe(false);
  });

  it("devuelve falso ante largos distintos en vez de lanzar", () => {
    // `timingSafeEqual` lanza si los buffers no miden lo mismo. En la ruta real
    // no puede pasar — los dos lados son seis dígitos — pero un throw dentro de
    // la verificación de un código sería un 500 en la pantalla de login.
    expect(equalsConstantTime("12345", "123456")).toBe(false);
    expect(equalsConstantTime("", "1")).toBe(false);
  });
});

describe("requireTotpEncKey", () => {
  it("lanza si no está definida", () => {
    expect(() => requireTotpEncKey({})).toThrow(/TOTP_ENC_KEY no está definida/);
  });

  it("acepta base64 de 32 bytes", () => {
    const key = Buffer.alloc(32, 3);
    expect(
      requireTotpEncKey({ TOTP_ENC_KEY: key.toString("base64") }).equals(key),
    ).toBe(true);
  });

  it("acepta hex de 32 bytes", () => {
    const key = Buffer.alloc(32, 4);
    expect(
      requireTotpEncKey({ TOTP_ENC_KEY: key.toString("hex") }).equals(key),
    ).toBe(true);
  });

  it("rechaza una passphrase corta en vez de estirarla en silencio", () => {
    expect(() => requireTotpEncKey({ TOTP_ENC_KEY: "clave-corta" })).toThrow(
      /tiene que medir 32/,
    );
  });
});
