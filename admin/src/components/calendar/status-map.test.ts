import { describe, expect, it } from "vitest";

import { STATUS_IDS } from "../ui/status";
import { EA_STATUS_MAP, eaStatusLabel, mapEaStatus, unmappedStatuses } from "./status-map";

describe("mapEaStatus", () => {
  it("traduce los cinco que siembra la migración 043 de EA", () => {
    expect(mapEaStatus("Booked")).toBe("reservada");
    expect(mapEaStatus("Confirmed")).toBe("confirmada");
    expect(mapEaStatus("Rescheduled")).toBe("reservada");
    expect(mapEaStatus("Cancelled")).toBe("cancelada");
  });

  it("traduce los seis que el estudio configura en español", () => {
    expect(mapEaStatus("Reservada")).toBe("reservada");
    expect(mapEaStatus("Confirmada")).toBe("confirmada");
    expect(mapEaStatus("Reprogramada")).toBe("reservada");
    expect(mapEaStatus("Completada")).toBe("completada");
    expect(mapEaStatus("No asistió")).toBe("no-asistio");
    expect(mapEaStatus("Cancelada")).toBe("cancelada");
  });

  it("no depende de tildes, mayúsculas ni separador", () => {
    for (const raw of ["NO ASISTIO", "no_asistio", "  No Asistió  ", "no-asistio"]) {
      expect(mapEaStatus(raw)).toBe("no-asistio");
    }
  });

  it("acepta las dos ortografías de cancelado", () => {
    expect(mapEaStatus("Canceled")).toBe("cancelada");
    expect(mapEaStatus("Cancelled")).toBe("cancelada");
  });

  // El caso que hace que la pantalla sea diagnosticable en vez de mentirosa.
  it("deja en desconocido lo que no está en la tabla", () => {
    expect(mapEaStatus("Pendiente de abono")).toBe("desconocido");
    expect(mapEaStatus("")).toBe("desconocido");
    expect(mapEaStatus(null)).toBe("desconocido");
    expect(mapEaStatus(undefined)).toBe("desconocido");
  });

  // Decidido acá y no en el plan: un borrador de EA es una reserva a medio
  // hacer y pintarla como reservada afirmaría que hay una clienta esperando.
  it("Draft no se pinta como reservada", () => {
    expect(mapEaStatus("Draft")).toBe("desconocido");
  });

  it("nunca devuelve un token fuera del catálogo de A3", () => {
    const permitidos = new Set<string>([...STATUS_IDS, "desconocido"]);
    for (const value of Object.values(EA_STATUS_MAP)) {
      expect(permitidos.has(value)).toBe(true);
    }
  });

  it("las claves de la tabla ya están normalizadas", () => {
    for (const key of Object.keys(EA_STATUS_MAP)) {
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toMatch(/[\s_]/);
      expect(key.normalize("NFD")).toBe(key);
    }
  });
});

describe("eaStatusLabel", () => {
  it("usa las etiquetas del catálogo de A3", () => {
    expect(eaStatusLabel("Booked")).toBe("Reservada");
    expect(eaStatusLabel("No asistió")).toBe("No asistió");
    expect(eaStatusLabel("Vaya uno a saber")).toBe("Sin reconocer");
  });
});

describe("unmappedStatuses", () => {
  it("junta las crudas sin reconocer, sin repetir y en orden", () => {
    expect(
      unmappedStatuses(["Booked", "Pendiente", "Confirmed", "Pendiente", "Abonada"]),
    ).toEqual(["Pendiente", "Abonada"]);
  });

  it("está vacío cuando todo se reconoce", () => {
    expect(unmappedStatuses(["Booked", "Cancelada", "Completada"])).toEqual([]);
  });

  it("cuenta la cadena vacía una sola vez", () => {
    expect(unmappedStatuses(["", null, undefined, ""])).toEqual([""]);
  });
});
