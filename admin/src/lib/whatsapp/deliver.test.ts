import { describe, expect, it } from "vitest";

import type { FetchLike } from "./cloud-api";
import type { WhatsappConfig } from "./config";
import { deliverTemplate, type DeliveryStore } from "./deliver";

const CONFIG: WhatsappConfig = {
  token: "t",
  phoneNumberId: "1234567890",
  graphVersion: "v23.0",
  templateLang: "es",
  templates: { confirmacion: "confirmacion_cita", recordatorio: "recordatorio_cita" },
};

const INPUT = {
  eaAppointmentId: 42,
  kind: "confirmacion" as const,
  phoneE164: "+573001234567",
  templateName: "confirmacion_cita",
  bodyParams: ["Laura", "Manos", "el viernes", "Lina"],
  scheduledFor: new Date("2026-10-15T15:00:00Z"),
};

/** Un store que anota el orden de las llamadas, y un fetch que también. */
function harness(options: { duplicate?: boolean; response?: () => Promise<Response> } = {}) {
  const log: string[] = [];
  const store: DeliveryStore = {
    async insertPending() {
      log.push("insert");
      return options.duplicate ? null : 7;
    },
    async markSent(id, messageId) {
      log.push(`sent:${id}:${messageId}`);
    },
    async markFailed(id, error) {
      log.push(`failed:${id}:${error.split(":")[0]}`);
    },
  };
  const fetchImpl: FetchLike = async () => {
    log.push("meta");
    return options.response
      ? options.response()
      : new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
  };
  return { log, store, fetchImpl };
}

describe("deliverTemplate", () => {
  it("la fila va antes de llamar a Meta, y después se anota el id", async () => {
    const { log, store, fetchImpl } = harness();
    const outcome = await deliverTemplate(store, CONFIG, INPUT, { fetchImpl });
    expect(outcome).toEqual({ status: "enviado", rowId: 7, messageId: "wamid.X" });
    expect(log).toEqual(["insert", "meta", "sent:7:wamid.X"]);
  });

  it("si ya había fila (de cualquier canal), no llama a Meta", async () => {
    const { log, store, fetchImpl } = harness({ duplicate: true });
    expect(await deliverTemplate(store, CONFIG, INPUT, { fetchImpl })).toEqual({ status: "ya-existe" });
    expect(log).toEqual(["insert"]);
  });

  it("un rechazo de Meta deja la fila en fallido, con el motivo codificado", async () => {
    const { log, store, fetchImpl } = harness({
      response: async () =>
        new Response(JSON.stringify({ error: { code: 130429, message: "rate" } }), { status: 429 }),
    });
    const outcome = await deliverTemplate(store, CONFIG, INPUT, { fetchImpl });
    expect(outcome.status).toBe("fallido");
    expect(log).toEqual(["insert", "meta", "failed:7:reintentable"]);
  });
});
