import { describe, expect, it } from "vitest";

import {
  FAILURE_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  planTotpAttempt,
  registerFailure,
  stepAt,
  totpAt,
  verifyTotpCode,
  type TotpAttemptState,
  type TotpEnrollment,
} from "./totp";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B2.
 *
 * TOTP es el **único** factor de las técnicas. Se ataca la ventana, la
 * anti-repetición, el presupuesto de intentos y el bloqueo, simulando secuencias
 * completas en vez de estados armados a mano.
 */

const SECRET = Buffer.from("12345678901234567890", "utf8");
const T0 = new Date("2026-08-31T14:00:00Z");

const limpio = (over: Partial<TotpAttemptState> = {}): TotpAttemptState => ({
  lastUsedStep: null,
  failedAttempts: 0,
  firstFailedAt: null,
  lockedUntil: null,
  ...over,
});

const enrolada = (state = limpio()): TotpEnrollment => ({
  secret: SECRET,
  confirmedAt: new Date("2026-01-01T00:00:00Z"),
  state,
});

const enMinutos = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
const enSteps = (base: Date, steps: number) =>
  new Date(base.getTime() + steps * TOTP_PERIOD_SECONDS * 1_000);

describe("AUDIT · la ventana es exactamente ±1 step, en 500 instantes distintos", () => {
  it("−1, 0 y +1 pasan; −2 y +2 no, para cualquier instante", () => {
    for (let i = 0; i < 500; i += 1) {
      const now = new Date(T0.getTime() + i * 7_919); // primo: cae en todas las fases
      const current = stepAt(now.getTime());

      const enVentana = new Set(
        [-1, 0, 1].map((d) => totpAt(SECRET, enSteps(now, d).getTime())),
      );

      for (const delta of [-3, -2, -1, 0, 1, 2, 3]) {
        const code = totpAt(SECRET, enSteps(now, delta).getTime());
        const v = verifyTotpCode({ secret: SECRET, code, now, state: limpio() });

        if (Math.abs(delta) <= 1) {
          expect(v, `delta ${delta} @ ${i}`).toEqual({ ok: true, step: current + delta });
        } else if (!enVentana.has(code)) {
          // (si un código de fuera coincide por azar con uno de adentro no es
          // un fallo del módulo: seis dígitos colisionan cada 10^6)
          expect(v.ok, `delta ${delta} @ ${i}`).toBe(false);
        }
      }
    }
  });
});

describe("AUDIT · anti-repetición: se rechaza step <= last_used_step", () => {
  it("todo step consumido y todo step anterior quedan cerrados, sobre 200 pasos", () => {
    for (let i = 0; i < 200; i += 1) {
      const now = new Date(T0.getTime() + i * 31_337);
      const current = stepAt(now.getTime());

      for (const usado of [current - 1, current, current + 1]) {
        for (const delta of [-1, 0, 1]) {
          const code = totpAt(SECRET, enSteps(now, delta).getTime());
          const v = verifyTotpCode({
            secret: SECRET,
            code,
            now,
            state: limpio({ lastUsedStep: usado }),
          });

          if (current + delta <= usado) {
            expect(v).toEqual({ ok: false, reason: "repetido" });
          } else {
            expect(v).toEqual({ ok: true, step: current + delta });
          }
        }
      }
    }
  });

  it("entrar con el código de las 10:00:30 cierra el de las 10:00:00", () => {
    const now = T0;
    const posterior = verifyTotpCode({
      secret: SECRET,
      code: totpAt(SECRET, enSteps(now, 1).getTime()),
      now,
      state: limpio(),
    });
    expect(posterior.ok).toBe(true);

    const anterior = verifyTotpCode({
      secret: SECRET,
      code: totpAt(SECRET, now.getTime()),
      now,
      state: limpio({ lastUsedStep: (posterior as { step: number }).step }),
    });
    expect(anterior).toEqual({ ok: false, reason: "repetido" });
  });
});

describe("AUDIT · el presupuesto de intentos de un atacante", () => {
  /** Corre una secuencia real: cada intento actualiza el estado como lo haría el repo. */
  function secuencia(codigos: { code: string; at: Date }[]): {
    resultados: string[];
    estado: TotpAttemptState;
  } {
    let estado = limpio();
    const resultados: string[] = [];

    for (const { code, at } of codigos) {
      const plan = planTotpAttempt({ enrollment: enrolada(estado), code, now: at });
      resultados.push(plan.kind === "deny" ? plan.reason : plan.kind);

      if (plan.kind === "deny" && plan.failure) {
        estado = {
          ...estado,
          failedAttempts: plan.failure.failedAttempts,
          firstFailedAt: plan.failure.firstFailedAt,
          lockedUntil: plan.failure.lockedUntil ?? estado.lockedUntil,
        };
      }

      if (plan.kind === "allow") {
        // Lo que hace `staffTotpRepository.consume()`: fija el step y limpia la
        // racha de fallos.
        estado = {
          lastUsedStep: plan.step,
          failedAttempts: 0,
          firstFailedAt: null,
          lockedUntil: null,
        };
      }
    }

    return { resultados, estado };
  }

  /** Un código de seis dígitos que con seguridad no cae en la ventana de `at`. */
  function codigoEquivocado(at: Date, salt: number): string {
    const validos = new Set([-1, 0, 1].map((d) => totpAt(SECRET, enSteps(at, d).getTime())));
    let candidato = (salt * 104_729) % 1_000_000;

    while (validos.has(String(candidato).padStart(6, "0"))) candidato += 1;

    return String(candidato % 1_000_000).padStart(6, "0");
  }

  it("cinco códigos bien formados y equivocados bloquean, el sexto ya no entra", () => {
    const intentos = Array.from({ length: 6 }, (_, i) => ({
      code: codigoEquivocado(enMinutos(T0, i), i + 1),
      at: enMinutos(T0, i),
    }));

    const { resultados, estado } = secuencia(intentos);

    expect(resultados.slice(0, 5)).toEqual(Array(5).fill("incorrecto"));
    expect(resultados[5]).toBe("locked");
    expect(estado.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(estado.lockedUntil!.getTime()).toBeGreaterThan(
      new Date("2100-01-01T00:00:00Z").getTime(),
    );
  });

  it("un código malformado no gasta intento por más veces que se mande", () => {
    const basura = ["", "1", "12345", "1234567", "abcdef", "12 34 5", "١٢٣٤٥٦", "12345a"];
    const { resultados, estado } = secuencia(
      Array.from({ length: 40 }, (_, i) => ({
        code: basura[i % basura.length],
        at: enMinutos(T0, i),
      })),
    );

    expect(new Set(resultados)).toEqual(new Set(["malformado"]));
    expect(estado.failedAttempts).toBe(0);
    expect(estado.lockedUntil).toBeNull();
  });

  it("un código repetido SÍ gasta intento: cinco reenvíos bloquean", () => {
    const code = totpAt(SECRET, T0.getTime());
    const primero = planTotpAttempt({ enrollment: enrolada(), code, now: T0 });
    expect(primero.kind).toBe("allow");

    let estado = limpio({ lastUsedStep: (primero as { step: number }).step });
    const razones: string[] = [];

    for (let i = 1; i <= 5; i += 1) {
      const plan = planTotpAttempt({ enrollment: enrolada(estado), code, now: T0 });
      razones.push(plan.kind === "deny" ? plan.reason : plan.kind);

      if (plan.kind === "deny" && plan.failure) {
        estado = {
          ...estado,
          failedAttempts: plan.failure.failedAttempts,
          firstFailedAt: plan.failure.firstFailedAt,
          lockedUntil: plan.failure.lockedUntil ?? estado.lockedUntil,
        };
      }
    }

    expect(razones).toEqual(Array(5).fill("repetido"));
    expect(estado.lockedUntil).not.toBeNull();
  });

  it("un login exitoso reinicia la racha (el repo lo hace, no el plan)", () => {
    // `planTotpAttempt()` no devuelve nada que diga "limpia la racha"; quien lo
    // hace es `staffTotpRepository.consume()`. Se fija acá porque sin ese
    // reinicio, cuatro errores de dedo + un login + un error de dedo bloquearían
    // a una técnica que acaba de entrar bien.
    const cuatroFallos = limpio({ failedAttempts: 4, firstFailedAt: T0 });
    const conFallos = registerFailure(cuatroFallos, enMinutos(T0, 1));
    expect(conFallos.lockedUntil).not.toBeNull();

    const trasLoginLimpio = registerFailure(limpio(), enMinutos(T0, 1));
    expect(trasLoginLimpio.failedAttempts).toBe(1);
    expect(trasLoginLimpio.lockedUntil).toBeNull();
  });

  it("la ventana de 15 minutos: el borde exacto reinicia la racha", () => {
    const justoDentro = registerFailure(
      limpio({ failedAttempts: 4, firstFailedAt: T0 }),
      new Date(T0.getTime() + FAILURE_WINDOW_MS - 1),
    );
    expect(justoDentro.failedAttempts).toBe(5);
    expect(justoDentro.lockedUntil).not.toBeNull();

    const justoFuera = registerFailure(
      limpio({ failedAttempts: 4, firstFailedAt: T0 }),
      new Date(T0.getTime() + FAILURE_WINDOW_MS),
    );
    expect(justoFuera.failedAttempts).toBe(1);
    expect(justoFuera.lockedUntil).toBeNull();
  });

  it("el bloqueo no se vence solo: sigue puesto cien años después", () => {
    const bloqueada = registerFailure(limpio({ failedAttempts: 4, firstFailedAt: T0 }), T0);
    const dentroDeUnAño = new Date(T0.getTime() + 365 * 86_400_000);

    expect(
      verifyTotpCode({
        secret: SECRET,
        code: totpAt(SECRET, dentroDeUnAño.getTime()),
        now: dentroDeUnAño,
        state: limpio({ lockedUntil: bloqueada.lockedUntil }),
      }),
    ).toEqual({ ok: false, reason: "bloqueado" });
  });

  it("sin fila y con el QR sin confirmar se contesta igual que un código malo, sin gastar intento", () => {
    for (const enrollment of [
      null,
      { secret: SECRET, confirmedAt: null, state: limpio() },
    ] as (TotpEnrollment | null)[]) {
      const plan = planTotpAttempt({
        enrollment,
        code: totpAt(SECRET, T0.getTime()),
        now: T0,
      });
      expect(plan).toEqual({ kind: "deny", reason: "incorrecto", failure: null });
    }
  });
});

describe("AUDIT · base32", () => {
  it("va y vuelve para 300 secretos aleatorios de largos distintos", () => {
    for (let len = 1; len <= 40; len += 1) {
      for (let i = 0; i < 8; i += 1) {
        const bytes = Buffer.from(
          Array.from({ length: len }, (_, k) => (i * 37 + k * 91 + len * 13) & 0xff),
        );
        const encoded = base32Encode(bytes);
        expect(base32Decode(encoded)?.subarray(0, len)).toEqual(bytes);
      }
    }
  });

  it("rechaza caracteres fuera del alfabeto en vez de ignorarlos", () => {
    for (const bad of ["MZXW6YTB01", "MZXW6YTB!", "MZ=XW6YTB", "", "   ", "0", "1", "8", "9"]) {
      expect(base32Decode(bad), bad).toBeNull();
    }
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 8 (menor, robustez) — con el reloj del proceso en la época Unix,
 * `verifyTotpCode()` **lanza** en vez de negar.
 *
 * La ventana prueba `current − 1`, y con `now` dentro de los primeros 30
 * segundos de 1970 ese candidato es `−1`. `hotp()` lo mete en
 * `writeBigUInt64BE`, que rechaza los negativos: el login contesta 500 en vez de
 * "código incorrecto". Un contenedor que arranca sin NTP es el caso.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · un reloj imposible no puede tumbar el login", () => {
  it("con el reloj en la época, se niega el acceso en vez de reventar", () => {
    const epoca = new Date(0);

    expect(() =>
      verifyTotpCode({ secret: SECRET, code: "123456", now: epoca, state: limpio() }),
    ).not.toThrow();
  });
});
