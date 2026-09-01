import { describe, expect, it } from "vitest";

import {
  constantTimeEquals,
  hashWebhookBody,
  verifyWebhookSecret,
  WebhookConfigError,
  webhookSecretFromEnv,
  type WebhookSecret,
} from "./webhook-verify";

const SECRET: WebhookSecret = { header: "X-GBS-Webhook", token: "s3cr3t-de-este-webhook" };

/** El header de *otro* webhook: mismo formato, valor distinto. */
const OTRO_WEBHOOK = "s3cr3t-de-otro-webhook";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("verifyWebhookSecret", () => {
  it("acepta el header correcto", () => {
    const result = verifyWebhookSecret(
      headers({ "X-GBS-Webhook": SECRET.token }),
      SECRET,
    );
    expect(result).toEqual({ ok: true });
  });

  it("acepta el header aunque venga con otra capitalización", () => {
    // Los nombres de header son case-insensitive por RFC, y EA manda el nombre
    // tal cual lo escribió quien configuró el webhook. Rechazar por mayúsculas
    // sería un fallo imposible de diagnosticar desde la interfaz de EA.
    expect(verifyWebhookSecret(headers({ "x-gbs-webhook": SECRET.token }), SECRET)).toEqual({
      ok: true,
    });
    expect(verifyWebhookSecret(headers({ "X-GBS-WEBHOOK": SECRET.token }), SECRET)).toEqual({
      ok: true,
    });
  });

  it("rechaza el header ausente", () => {
    // Es el caso real más probable: EA solo manda el header si el webhook tiene
    // `secret_header` **y** `secret_token` cargados, y no avisa si falta uno.
    expect(verifyWebhookSecret(headers({}), SECRET)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rechaza el header presente pero vacío, y lo distingue del ausente", () => {
    expect(verifyWebhookSecret(headers({ "X-GBS-Webhook": "" }), SECRET)).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(verifyWebhookSecret(headers({ "X-GBS-Webhook": "   " }), SECRET)).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rechaza el valor de otro webhook", () => {
    expect(verifyWebhookSecret(headers({ "X-GBS-Webhook": OTRO_WEBHOOK }), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rechaza un prefijo y un sufijo del secreto", () => {
    // Un verificador escrito con `startsWith` o `includes` pasaría estos dos.
    for (const valor of [SECRET.token.slice(0, -1), `${SECRET.token}x`]) {
      expect(verifyWebhookSecret(headers({ "X-GBS-Webhook": valor }), SECRET)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    }
  });

  it("no llega a ver los espacios de los bordes: los recorta el runtime", () => {
    // Verificado, no supuesto: `Headers` normaliza el OWS de los bordes al
    // guardar el valor (RFC 9110 §5.5), así que ` token ` y `token` son el
    // mismo header antes de que este módulo lo mire. Queda fijado acá para que
    // nadie "arregle" el verificador agregándole un `trim()` que no hace falta
    // — y que sí ampliaría el conjunto de valores aceptados si algún día el
    // llamador no fuera un `Headers`.
    expect(headers({ "X-GBS-Webhook": ` ${SECRET.token} ` }).get("X-GBS-Webhook")).toBe(
      SECRET.token,
    );
    // Contra una fuente de headers que no normalice, el espacio sí importa.
    const crudo = { get: (name: string) => (name === "X-GBS-Webhook" ? ` ${SECRET.token}` : null) };
    expect(verifyWebhookSecret(crudo, SECRET)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("busca el header que dice la configuración, no uno fijo en el código", () => {
    const otroNombre: WebhookSecret = { header: "X-Firma-Rara", token: SECRET.token };
    expect(verifyWebhookSecret(headers({ "X-Firma-Rara": SECRET.token }), otroNombre)).toEqual({
      ok: true,
    });
    expect(verifyWebhookSecret(headers({ "X-GBS-Webhook": SECRET.token }), otroNombre)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("nunca devuelve el valor recibido ni el esperado en el resultado", () => {
    // El motivo del rechazo termina en un log y en Diagnóstico. Si arrastrara
    // el valor, el secreto viviría en texto plano en la primera línea de log
    // que alguien pegue en un chat para pedir ayuda.
    const result = verifyWebhookSecret(headers({ "X-GBS-Webhook": OTRO_WEBHOOK }), SECRET);
    const serializado = JSON.stringify(result);
    expect(serializado).not.toContain(OTRO_WEBHOOK);
    expect(serializado).not.toContain(SECRET.token);
  });
});

describe("constantTimeEquals", () => {
  it("es verdadero solo para cadenas idénticas", () => {
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "ABC")).toBe(false);
  });

  it("no lanza con largos distintos", () => {
    // `timingSafeEqual` crudo lanza cuando los buffers no miden lo mismo, y esa
    // excepción sería en sí misma el oráculo de longitud que se quiere evitar.
    expect(() => constantTimeEquals("a", "abcdefghijklmnop")).not.toThrow();
    expect(constantTimeEquals("a", "abcdefghijklmnop")).toBe(false);
  });

  it("compara bytes, no caracteres: distingue textos que se ven parecidos", () => {
    expect(constantTimeEquals("café", "cafe")).toBe(false);
    // Misma cadena en dos normalizaciones Unicode: se ven igual, no lo son.
    expect(constantTimeEquals("café", "café")).toBe(false);
  });
});

describe("webhookSecretFromEnv", () => {
  it("lee las dos variables y recorta los espacios del nombre y del valor", () => {
    expect(
      webhookSecretFromEnv({
        EA_WEBHOOK_SECRET_HEADER: " X-GBS-Webhook ",
        EA_WEBHOOK_SECRET_TOKEN: " abc123 ",
      }),
    ).toEqual({ header: "X-GBS-Webhook", token: "abc123" });
  });

  it("falla si falta el nombre del header", () => {
    expect(() => webhookSecretFromEnv({ EA_WEBHOOK_SECRET_TOKEN: "abc" })).toThrow(
      WebhookConfigError,
    );
  });

  it("falla si falta el token, o si viene en blanco", () => {
    expect(() =>
      webhookSecretFromEnv({ EA_WEBHOOK_SECRET_HEADER: "X-GBS-Webhook" }),
    ).toThrow(WebhookConfigError);
    expect(() =>
      webhookSecretFromEnv({
        EA_WEBHOOK_SECRET_HEADER: "X-GBS-Webhook",
        EA_WEBHOOK_SECRET_TOKEN: "   ",
      }),
    ).toThrow(WebhookConfigError);
  });

  it("no incluye el valor del secreto en el mensaje de error", () => {
    try {
      webhookSecretFromEnv({ EA_WEBHOOK_SECRET_TOKEN: "s3cr3t-que-no-debe-salir" });
      expect.unreachable("debía lanzar");
    } catch (error) {
      expect(String(error)).not.toContain("s3cr3t-que-no-debe-salir");
      expect(String(error)).toContain("EA_WEBHOOK_SECRET_HEADER");
    }
  });
});

describe("hashWebhookBody", () => {
  it("da 64 hex y es estable para el mismo cuerpo", () => {
    const cuerpo = '{"action":"appointment_save","payload":{"id":1}}';
    const hash = hashWebhookBody(cuerpo);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookBody(cuerpo)).toBe(hash);
  });

  it("cambia con cualquier diferencia del cuerpo, incluido el orden de las claves", () => {
    // Es lo que hace que la deduplicación sea del **evento** y no de la
    // entidad: dos ediciones distintas de la misma cita tienen hashes
    // distintos y las dos se procesan.
    const a = hashWebhookBody('{"action":"appointment_save","payload":{"id":1}}');
    const b = hashWebhookBody('{"action":"appointment_save","payload":{"id":2}}');
    const c = hashWebhookBody('{"payload":{"id":1},"action":"appointment_save"}');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
