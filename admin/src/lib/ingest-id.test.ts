import { describe, expect, it } from "vitest";

import {
  AGENDAPRO_TX_PREFIX,
  EA_PAYMENT_PREFIX,
  EA_TX_PREFIX,
  IngestIdError,
  buildAgendaproImportedId,
  buildEaAdjustmentImportedId,
  buildEaImportedId,
  buildPaymentSourceTxId,
  parseImportedId,
} from "./ingest-id";

/**
 * "Test exhaustivo, no de ejemplo" — es lo que pide el plan, y con razón: una
 * colisión de `imported_id` no da error en ninguna parte. Actual se come una
 * transacción en silencio o importa la misma dos veces, y el número aparece
 * mal en un reporte mensual dos meses después, sin nada que apunte hacia acá.
 *
 * Así que el bloque central no comprueba ejemplos: **genera decenas de miles de
 * ids de los tres namespaces y afirma que no hay dos iguales.**
 */

describe("los tres namespaces no colisionan jamás", () => {
  it("decenas de miles de ids, cero repetidos", () => {
    const ids = new Set<string>();
    let generated = 0;

    const add = (id: string): void => {
      ids.add(id);
      generated += 1;
    };

    for (let appointmentId = 1; appointmentId <= 2_000; appointmentId += 1) {
      add(buildEaImportedId(appointmentId));

      for (let sequence = 1; sequence <= 5; sequence += 1) {
        add(buildEaAdjustmentImportedId(appointmentId, sequence));
      }

      // El histórico de Agenda Pro con los mismos números, que es la forma más
      // probable de que dos mundos se toquen: el mismo entero como tx_id.
      add(buildAgendaproImportedId(String(appointmentId)));
    }

    expect(generated).toBe(2_000 * 7);
    expect(ids.size).toBe(generated);
  });

  it("un tx_id de Agenda Pro que imita a uno de EA sigue sin colisionar", () => {
    // El caso adversarial: alguien con un tx_id histórico que literalmente es
    // "ea-tx:42". El prefijo propio lo mantiene aparte.
    const agendapro = buildAgendaproImportedId("ea-tx:42");
    const ea = buildEaImportedId(42);

    expect(agendapro).not.toBe(ea);
    expect(agendapro).toBe("agendapro-tx:ea-tx:42");
  });

  it("un id de cita y el ajuste de otra no se pueden confundir", () => {
    // `ea-tx:12` contra `ea-tx:1` + `:adj2`. Sin ids canónicos y sin el `:adj`
    // literal, éste es el par que colisionaría.
    expect(buildEaImportedId(12)).not.toBe(buildEaAdjustmentImportedId(1, 2));
    expect(buildEaImportedId(1123)).not.toBe(buildEaAdjustmentImportedId(11, 23));
  });

  it("ningún prefijo es prefijo de otro", () => {
    // Es la propiedad estructural de la que dependen todas las de arriba. Si
    // algún día alguien agrega un cuarto namespace, este test es el que le
    // avisa que lo eligió mal.
    const prefixes = [AGENDAPRO_TX_PREFIX, EA_TX_PREFIX, EA_PAYMENT_PREFIX];

    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(a.startsWith(b)).toBe(false);
      }
    }
  });

  it("la llave de Strapi y la de Actual son distintas para la misma cita", () => {
    // Dos sistemas, dos llaves. Una fila `Payment` es "la cuenta de esta cita";
    // una transacción de Actual es "el movimiento de plata".
    expect(buildPaymentSourceTxId(42)).toBe("ea-appt:42");
    expect(buildEaImportedId(42)).toBe("ea-tx:42");
    expect(buildPaymentSourceTxId(42)).not.toBe(buildEaImportedId(42));
  });
});

describe("ids canónicos: una cita, un id, para siempre", () => {
  it("el mismo id de cita produce siempre la misma cadena", () => {
    expect(buildEaImportedId(7)).toBe(buildEaImportedId(7));
    expect(buildEaImportedId(7)).toBe("ea-tx:7");
  });

  it("rechaza todo lo que produciría dos ids para la misma cita", () => {
    // Un `007` daría `ea-tx:007`, distinto de `ea-tx:7`, y la corrección de
    // mañana no encontraría la transacción de hoy.
    for (const invalido of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => buildEaImportedId(invalido)).toThrow(IngestIdError);
      expect(() => buildPaymentSourceTxId(invalido)).toThrow(IngestIdError);
      expect(() => buildEaAdjustmentImportedId(invalido, 1)).toThrow(IngestIdError);
      expect(() => buildEaAdjustmentImportedId(1, invalido)).toThrow(IngestIdError);
    }
  });

  it("el número de ajuste arranca en 1", () => {
    expect(buildEaAdjustmentImportedId(42, 1)).toBe("ea-tx:42:adj1");
    expect(() => buildEaAdjustmentImportedId(42, 0)).toThrow(/número de ajuste/);
  });

  it("el tx_id histórico no se normaliza: se copia tal cual", () => {
    // Cualquier transformación produciría un id distinto del que Actual ya
    // tiene, que es exactamente el error que duplica ingresos.
    expect(buildAgendaproImportedId("  A-42  ")).toBe("agendapro-tx:  A-42  ");
    expect(buildAgendaproImportedId("Ñ/1")).toBe("agendapro-tx:Ñ/1");
  });

  it("pero un tx_id vacío no puede haber sido un id", () => {
    expect(() => buildAgendaproImportedId("")).toThrow(IngestIdError);
    expect(() => buildAgendaproImportedId("   ")).toThrow(/no puede estar vacío/);
  });
});

describe("parseImportedId — leer de vuelta", () => {
  it("hace round-trip con todo lo que este módulo construye", () => {
    for (let id = 1; id <= 300; id += 1) {
      expect(parseImportedId(buildEaImportedId(id))).toEqual({
        source: "ea",
        eaAppointmentId: id,
        sequence: null,
      });

      for (let sequence = 1; sequence <= 3; sequence += 1) {
        expect(parseImportedId(buildEaAdjustmentImportedId(id, sequence))).toEqual({
          source: "ea",
          eaAppointmentId: id,
          sequence,
        });
      }

      expect(parseImportedId(buildAgendaproImportedId(`tx-${id}`))).toEqual({
        source: "agendapro",
        txId: `tx-${id}`,
      });
    }
  });

  it("devuelve null para formas que este módulo nunca habría escrito", () => {
    // Un parseo optimista de `ea-tx:007` lo trataría como la cita 7, y ahí
    // nace la doble importación.
    const invalidos = [
      "ea-tx:007",
      "ea-tx:0",
      "ea-tx:-1",
      "ea-tx:1.5",
      "ea-tx:",
      "ea-tx:abc",
      "ea-tx:1:adj0",
      "ea-tx:1:adj",
      "ea-tx:1:adj01",
      "ea-tx:1:adj1:adj2",
      "ea-tx:0:adj1",
      "ea-tx::adj1",
      "ea-appt:42",
      "agendapro-tx:",
      "agendapro-tx:   ",
      "cualquier-otra-cosa",
      "",
    ];

    for (const invalido of invalidos) {
      expect(parseImportedId(invalido)).toBeNull();
    }
  });

  it("devuelve null para lo que ni siquiera es una cadena", () => {
    // Viene de la API de Actual en el dry-run; no hay garantía de tipo.
    for (const invalido of [null, undefined, 42, {}, []]) {
      expect(parseImportedId(invalido)).toBeNull();
    }
  });

  it("un tx_id histórico que contiene ':adj' no se parsea como ajuste", () => {
    expect(parseImportedId("agendapro-tx:1:adj1")).toEqual({
      source: "agendapro",
      txId: "1:adj1",
    });
  });
});
