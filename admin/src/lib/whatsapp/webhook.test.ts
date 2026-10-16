import { describe, expect, it } from "vitest";

import type { WaMessageStatus } from "@/db/types";

import {
  applyWebhook,
  isOptOutKeyword,
  mapMetaStatus,
  nextStatus,
  parseWebhookPayload,
  signatureFor,
  verificationChallenge,
  verifyMetaSignature,
  type WebhookStore,
} from "./webhook";

const SECRET = "app-secret-de-prueba";
const BODY = '{"object":"whatsapp_business_account","entry":[]}';

describe("verifyMetaSignature", () => {
  it("acepta el HMAC-SHA256 del cuerpo crudo", () => {
    expect(verifyMetaSignature(BODY, signatureFor(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("acepta el hex en mayúsculas (un proxy podría cambiarlo)", () => {
    const sig = signatureFor(BODY, SECRET);
    expect(verifyMetaSignature(BODY, `sha256=${sig.slice(7).toUpperCase()}`, SECRET).ok).toBe(true);
  });

  it("rechaza sin header", () => {
    expect(verifyMetaSignature(BODY, null, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyMetaSignature(BODY, "  ", SECRET)).toEqual({ ok: false, reason: "missing" });
  });

  it("rechaza un header que no es sha256=<64 hex>", () => {
    expect(verifyMetaSignature(BODY, "sha1=abc", SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rechaza otra clave, o el cuerpo alterado", () => {
    expect(verifyMetaSignature(BODY, signatureFor(BODY, "otra"), SECRET)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    // Mismo JSON con otro espaciado: la firma es de los bytes, no del objeto.
    const reformatted = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyMetaSignature(reformatted, signatureFor(BODY, SECRET), SECRET).ok).toBe(false);
  });
});

describe("verificationChallenge", () => {
  const params = (over: Record<string, string>) =>
    new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "token-verif",
      "hub.challenge": "1158201444",
      ...over,
    });

  it("devuelve el challenge con el token correcto", () => {
    expect(verificationChallenge(params({}), "token-verif")).toBe("1158201444");
  });

  it("null con otro token, otro modo o un challenge raro", () => {
    expect(verificationChallenge(params({ "hub.verify_token": "x" }), "token-verif")).toBeNull();
    expect(verificationChallenge(params({ "hub.mode": "unsubscribe" }), "token-verif")).toBeNull();
    expect(
      verificationChallenge(params({ "hub.challenge": "<script>" }), "token-verif"),
    ).toBeNull();
  });
});

describe("estados", () => {
  it("traduce los cuatro de Meta e ignora el resto", () => {
    expect(mapMetaStatus("sent")).toBe("enviado");
    expect(mapMetaStatus("delivered")).toBe("entregado");
    expect(mapMetaStatus("read")).toBe("leido");
    expect(mapMetaStatus("failed")).toBe("fallido");
    expect(mapMetaStatus("deleted")).toBeNull();
  });

  it("solo avanza: un delivered después del read no cambia nada", () => {
    expect(nextStatus("leido", "entregado")).toBeNull();
    expect(nextStatus("entregado", "enviado")).toBeNull();
    expect(nextStatus("enviado", "enviado")).toBeNull();
    expect(nextStatus("enviado", "entregado")).toBe("entregado");
    expect(nextStatus("pendiente", "leido")).toBe("leido");
  });

  it("un mensaje entregado no pasa a fallido", () => {
    expect(nextStatus("entregado", "fallido")).toBeNull();
    expect(nextStatus("leido", "fallido")).toBeNull();
    expect(nextStatus("enviado", "fallido")).toBe("fallido");
  });

  it("nada resucita una fila omitida o fallida", () => {
    for (const incoming of ["enviado", "entregado", "leido"] as const) {
      expect(nextStatus("omitido", incoming)).toBeNull();
      expect(nextStatus("fallido", incoming)).toBeNull();
    }
  });
});

describe("isOptOutKeyword", () => {
  it("reconoce BAJA, STOP y NO como mensaje completo, sin importar mayúsculas ni tildes", () => {
    for (const text of ["BAJA", "baja", " Baja. ", "STOP", "stop!", "No", "no más", "NO MAS", "Dar de baja"]) {
      expect(isOptOutKeyword(text), text).toBe(true);
    }
  });

  it("no confunde una respuesta con una baja", () => {
    for (const text of ["no puedo ir mañana", "No, gracias, ahí estaré", "¿Puedo cambiarla?", "bajar", "ok"]) {
      expect(isOptOutKeyword(text), text).toBe(false);
    }
  });
});

function payload(value: Record<string, unknown>, phoneNumberId = "111") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, ...value },
          },
        ],
      },
    ],
  };
}

describe("parseWebhookPayload", () => {
  it("saca estados y textos entrantes", () => {
    const parsed = parseWebhookPayload(
      payload({
        statuses: [
          { id: "wamid.1", status: "delivered", recipient_id: "573001234567" },
          {
            id: "wamid.2",
            status: "failed",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
          { id: "wamid.3", status: "deleted" },
        ],
        messages: [
          { from: "573001234567", id: "wamid.in", type: "text", text: { body: "BAJA" } },
          { from: "573001234567", id: "wamid.img", type: "image", image: {} },
        ],
      }),
      "111",
    );
    expect(parsed.statuses).toEqual([
      { providerMessageId: "wamid.1", status: "entregado", error: null },
      {
        providerMessageId: "wamid.2",
        status: "fallido",
        error: expect.stringMatching(/^definitivo:131026: /),
      },
    ]);
    expect(parsed.inbound).toEqual([{ from: "573001234567", text: "BAJA" }]);
  });

  it("ignora eventos de otro número de la misma cuenta", () => {
    const parsed = parseWebhookPayload(
      payload({ statuses: [{ id: "wamid.1", status: "read" }] }, "999"),
      "111",
    );
    expect(parsed.statuses).toEqual([]);
  });

  it("no lanza con basura", () => {
    for (const body of [null, "x", 1, [], { entry: "x" }, { entry: [{ changes: [{ field: "x" }] }] }]) {
      expect(parseWebhookPayload(body, null)).toEqual({ statuses: [], inbound: [] });
    }
  });
});

describe("applyWebhook", () => {
  function fakeStore(initial: Record<string, WaMessageStatus>) {
    const rows = { ...initial };
    const optouts = new Set<string>();
    const store: WebhookStore = {
      async applyProviderStatus({ providerMessageId, status, from }) {
        const current = rows[providerMessageId];
        if (current === undefined || !from.includes(current)) return 0;
        rows[providerMessageId] = status;
        return 1;
      },
      async addOptout(phone) {
        if (optouts.has(phone)) return false;
        optouts.add(phone);
        return true;
      },
    };
    return { store, rows, optouts };
  }

  const normalize = (raw: string) => (/^\+\d{8,15}$/.test(raw) ? raw : null);

  it("aplica y es idempotente: el mismo POST dos veces no cambia más", async () => {
    const { store, rows, optouts } = fakeStore({ "wamid.1": "enviado" });
    const parsed = parseWebhookPayload(
      payload({
        statuses: [{ id: "wamid.1", status: "read" }],
        messages: [{ from: "573001234567", type: "text", text: { body: "stop" } }],
      }),
      null,
    );

    expect(await applyWebhook(parsed, store, normalize)).toEqual({ updated: 1, ignored: 0, optouts: 1 });
    expect(await applyWebhook(parsed, store, normalize)).toEqual({ updated: 0, ignored: 1, optouts: 0 });
    expect(rows["wamid.1"]).toBe("leido");
    expect([...optouts]).toEqual(["+573001234567"]);
  });

  it("los estados desordenados terminan en el más avanzado", async () => {
    const { store, rows } = fakeStore({ "wamid.1": "pendiente" });
    const parsed = parseWebhookPayload(
      payload({
        statuses: [
          { id: "wamid.1", status: "read" },
          { id: "wamid.1", status: "delivered" },
          { id: "wamid.1", status: "sent" },
        ],
      }),
      null,
    );
    await applyWebhook(parsed, store, normalize);
    expect(rows["wamid.1"]).toBe("leido");
  });

  it("un texto que no es baja no escribe nada", async () => {
    const { store, optouts } = fakeStore({});
    const parsed = parseWebhookPayload(
      payload({ messages: [{ from: "573001234567", type: "text", text: { body: "Gracias!" } }] }),
      null,
    );
    await applyWebhook(parsed, store, normalize);
    expect(optouts.size).toBe(0);
  });
});
