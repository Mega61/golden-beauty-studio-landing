import { describe, expect, it } from "vitest";

import {
  classifyResponse,
  encodeSendError,
  isRetryableError,
  mapMetaError,
  readableSendError,
  sendTemplate,
  templateRequestBody,
  type FetchLike,
} from "./cloud-api";
import type { WhatsappConfig } from "./config";

const CONFIG: WhatsappConfig = {
  token: "EAAG-secreto-que-no-sale",
  phoneNumberId: "1234567890",
  graphVersion: "v23.0",
  templateLang: "es",
  templates: { confirmacion: "confirmacion_cita", recordatorio: "recordatorio_cita" },
};

const INPUT = {
  to: "+573001234567",
  templateName: "recordatorio_cita",
  bodyParams: ["Laura", "Semipermanente manos", "hoy a las 3:00 p. m.", "Lina"],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mapMetaError", () => {
  it("los límites de tasa se reintentan", () => {
    for (const code of [130429, 131056, 80007, 4]) {
      expect(mapMetaError(code).retryable, String(code)).toBe(true);
    }
  });

  it("número sin WhatsApp, ventana de 24 h, token y plantillas no se reintentan", () => {
    for (const code of [131026, 131047, 190, 132000, 132001, 132015, 132016, 131030]) {
      expect(mapMetaError(code).retryable, String(code)).toBe(false);
    }
  });

  it("el token vencido dice qué hacer", () => {
    expect(mapMetaError(190).message).toMatch(/token/i);
  });

  it("un código desconocido es no reintentable y conserva el texto de Meta", () => {
    const mapped = mapMetaError(999999, "Something odd");
    expect(mapped).toEqual({
      retryable: false,
      code: "999999",
      message: "Meta rechazó el mensaje: Something odd",
    });
  });

  it("sin código ni texto, igual devuelve algo legible", () => {
    expect(mapMetaError(null)).toEqual({
      retryable: false,
      code: "desconocido",
      message: "Meta rechazó el mensaje.",
    });
  });
});

describe("templateRequestBody", () => {
  it("es una plantilla con los parámetros del cuerpo en orden, y el número sin +", () => {
    const body = templateRequestBody(INPUT, "es_CO");
    expect(body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001234567",
      type: "template",
      template: {
        name: "recordatorio_cita",
        language: { code: "es_CO" },
        components: [
          {
            type: "body",
            parameters: INPUT.bodyParams.map((text) => ({ type: "text", text })),
          },
        ],
      },
    });
  });

  it("sin parámetros no manda un componente vacío", () => {
    expect(templateRequestBody({ ...INPUT, bodyParams: [] }, "es").template.components).toEqual([]);
  });
});

describe("classifyResponse", () => {
  it("200 con id es éxito", () => {
    expect(classifyResponse(200, { messages: [{ id: "wamid.ABC" }] })).toEqual({
      ok: true,
      messageId: "wamid.ABC",
    });
  });

  it("200 sin id no se da por enviado ni se reintenta", () => {
    const result = classifyResponse(200, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });

  it("el error de Graph se traduce por su código", () => {
    const result = classifyResponse(400, {
      error: { code: 132001, message: "Template name does not exist in the translation" },
    });
    expect(result).toMatchObject({ ok: false, retryable: false, code: "132001" });
  });

  it("un 5xx sin cuerpo de Graph es reintentable; un 4xx no", () => {
    expect(classifyResponse(502, null)).toMatchObject({ ok: false, retryable: true, code: "http-502" });
    expect(classifyResponse(404, null)).toMatchObject({ ok: false, retryable: false, code: "http-404" });
  });
});

describe("sendTemplate", () => {
  it("llama a /{phone-number-id}/messages con el token en el header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return json(200, { messages: [{ id: "wamid.1" }] });
    };
    const result = await sendTemplate(CONFIG, INPUT, fetchImpl);
    expect(result).toEqual({ ok: true, messageId: "wamid.1" });
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFIG.token}`,
    );
    expect(JSON.parse(String(calls[0].init.body)).template.language.code).toBe("es");
  });

  it("un timeout NO es reintentable: el mensaje pudo haber salido", async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    };
    const result = await sendTemplate(CONFIG, INPUT, fetchImpl);
    expect(result).toMatchObject({ ok: false, retryable: false, code: "timeout" });
  });

  it("un error de red tampoco", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await sendTemplate(CONFIG, INPUT, fetchImpl)).toMatchObject({
      ok: false,
      retryable: false,
      code: "red",
    });
  });

  it("un cuerpo que no es JSON no lanza", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>bad gateway</html>", { status: 502 });
    expect(await sendTemplate(CONFIG, INPUT, fetchImpl)).toMatchObject({ ok: false, retryable: true });
  });

  it("ningún resultado lleva el token ni el teléfono completo", async () => {
    const outcomes = await Promise.all([
      sendTemplate(CONFIG, INPUT, async () => json(401, { error: { code: 190, message: "bad token" } })),
      sendTemplate(CONFIG, INPUT, async () => {
        throw new TypeError("fetch failed");
      }),
    ]);
    for (const outcome of outcomes) {
      const text = JSON.stringify(outcome);
      expect(text).not.toContain(CONFIG.token);
      expect(text).not.toContain("3001234567");
    }
  });
});

describe("el texto de error guardado", () => {
  it("lleva si es reintentable al principio, y se lee sin el prefijo", () => {
    const retry = encodeSendError({ ok: false, retryable: true, code: "130429", message: "Límite." });
    const final = encodeSendError({ ok: false, retryable: false, code: "131026", message: "Sin WhatsApp." });
    expect(isRetryableError(retry)).toBe(true);
    expect(isRetryableError(final)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(readableSendError(retry)).toBe("Límite.");
    expect(readableSendError(final)).toBe("Sin WhatsApp.");
    expect(readableSendError("texto suelto")).toBe("texto suelto");
    expect(readableSendError(null)).toBeNull();
  });

  it("se recorta a lo que cabe en la columna", () => {
    const long = encodeSendError({ ok: false, retryable: false, code: "x", message: "a".repeat(900) });
    expect(long.length).toBe(500);
  });
});
