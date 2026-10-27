import { describe, expect, it } from "vitest";

import { waSentLabelsByAppointment, type WaSentRow } from "./sent-labels";

const fila = (
  eaAppointmentId: number,
  kind: WaSentRow["kind"],
  status: WaSentRow["status"],
): WaSentRow => ({ eaAppointmentId, kind, status });

describe("waSentLabelsByAppointment", () => {
  it("confirmación y recordatorio, en ese orden", () => {
    const labels = waSentLabelsByAppointment([
      fila(1, "recordatorio_24h", "entregado"),
      fila(1, "confirmacion", "enviado"),
    ]);
    expect(labels.get(1)?.map((l) => l.text)).toEqual([
      "Confirmación enviada",
      "Recordatorio enviado",
    ]);
  });

  it("lo pendiente y lo omitido no se muestran: no salió nada", () => {
    const labels = waSentLabelsByAppointment([
      fila(1, "confirmacion", "pendiente"),
      fila(2, "recordatorio_2h", "omitido"),
    ]);
    expect(labels.get(1)).toBeUndefined();
    expect(labels.get(2)).toBeUndefined();
  });

  it("los dos recordatorios son una etiqueta, y gana la mejor noticia", () => {
    const labels = waSentLabelsByAppointment([
      fila(1, "recordatorio_24h", "leido"),
      fila(1, "recordatorio_2h", "fallido"),
    ]);
    expect(labels.get(1)).toEqual([
      { kind: "recordatorio", state: "leido", text: "Recordatorio leído" },
    ]);
  });

  it("un fallo se dice", () => {
    const labels = waSentLabelsByAppointment([fila(3, "confirmacion", "fallido")]);
    expect(labels.get(3)?.[0]).toMatchObject({ state: "fallido", text: "Confirmación falló" });
  });
});
