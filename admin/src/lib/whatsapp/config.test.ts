import { describe, expect, it } from "vitest";

import {
  maskPhone,
  parseWhatsappEnv,
  parseWhatsappWebhookEnv,
  whatsappConfigured,
} from "./config";

const BASE = { WHATSAPP_TOKEN: "EAAGtoken", WHATSAPP_PHONE_NUMBER_ID: "109876543210" };

describe("parseWhatsappEnv", () => {
  it("sin token o sin id, la función no existe", () => {
    expect(parseWhatsappEnv({})).toBeNull();
    expect(parseWhatsappEnv({ WHATSAPP_TOKEN: "x" })).toBeNull();
    expect(parseWhatsappEnv({ WHATSAPP_PHONE_NUMBER_ID: "109876543210" })).toBeNull();
    expect(whatsappConfigured({})).toBe(false);
  });

  it("con los dos, toma los valores por defecto", () => {
    expect(parseWhatsappEnv(BASE)).toEqual({
      token: "EAAGtoken",
      phoneNumberId: "109876543210",
      graphVersion: "v23.0",
      templateLang: "es",
      templates: { confirmacion: "confirmacion_cita", recordatorio: "recordatorio_cita" },
    });
    expect(whatsappConfigured(BASE)).toBe(true);
  });

  it("respeta idioma, versión y nombres de plantilla", () => {
    const config = parseWhatsappEnv({
      ...BASE,
      WHATSAPP_GRAPH_VERSION: "v24.0",
      WHATSAPP_TEMPLATE_LANG: "es_CO",
      WHATSAPP_TPL_CONFIRMACION: "confirmacion_v2",
      WHATSAPP_TPL_RECORDATORIO: "recordatorio_v2",
    });
    expect(config).toMatchObject({
      graphVersion: "v24.0",
      templateLang: "es_CO",
      templates: { confirmacion: "confirmacion_v2", recordatorio: "recordatorio_v2" },
    });
  });

  it("un número de teléfono pegado en vez del Phone Number ID apaga la función", () => {
    expect(parseWhatsappEnv({ ...BASE, WHATSAPP_PHONE_NUMBER_ID: "+57 300 123 4567" })).toBeNull();
  });

  it("valores mal formados apagan la función en vez de fallar en cada envío", () => {
    expect(parseWhatsappEnv({ ...BASE, WHATSAPP_TPL_CONFIRMACION: "Confirmación Cita" })).toBeNull();
    expect(parseWhatsappEnv({ ...BASE, WHATSAPP_TEMPLATE_LANG: "español" })).toBeNull();
    expect(parseWhatsappEnv({ ...BASE, WHATSAPP_GRAPH_VERSION: "23" })).toBeNull();
    expect(parseWhatsappEnv({ ...BASE, WHATSAPP_TOKEN: "abc def" })).toBeNull();
  });
});

describe("parseWhatsappWebhookEnv", () => {
  it("necesita los dos secretos", () => {
    expect(parseWhatsappWebhookEnv({ WHATSAPP_APP_SECRET: "s" })).toBeNull();
    expect(parseWhatsappWebhookEnv({ WHATSAPP_VERIFY_TOKEN: "v" })).toBeNull();
    expect(
      parseWhatsappWebhookEnv({ WHATSAPP_APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "v" }),
    ).toEqual({ appSecret: "s", verifyToken: "v", phoneNumberId: null });
  });
});

describe("maskPhone", () => {
  it("deja el indicativo y los últimos cuatro", () => {
    expect(maskPhone("+573001234567")).toBe("+57••••••4567");
    expect(maskPhone("+573001234567")).not.toContain("300123");
  });
});
