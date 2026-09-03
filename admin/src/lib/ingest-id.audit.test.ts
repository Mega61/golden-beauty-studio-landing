import { describe, expect, it } from "vitest";

import {
  buildAgendaproImportedId,
  buildEaAdjustmentImportedId,
  buildEaImportedId,
  buildPaymentSourceTxId,
  parseImportedId,
} from "./ingest-id";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 *
 * Una colisión de `imported_id` duplica o pierde ingresos en Actual Budget sin
 * un solo error visible. El builder probó "decenas de miles"; acá se amplía el
 * espacio y se agregan los `tx_id` históricos hostiles — el único campo del
 * módulo que es una cadena opaca de afuera.
 */

const TX_HOSTILES = [
  "1",
  "007",
  "ea-tx:1",
  "ea-tx:1:adj1",
  "ea-appt:1",
  "agendapro-tx:1",
  ":adj1",
  "1:adj1",
  "1:adj",
  "  1  ",
  "1\n2",
  "1\t2",
  "①",
  "-1",
  "1e3",
  "0x1",
  "1.0",
  "Infinity",
  "NaN",
  "__proto__",
  "constructor",
  "1;DROP TABLE",
  "1".repeat(200),
];

describe("AUDIT · ninguna llave colisiona jamás", () => {
  it("cientos de miles de combinaciones, cero repetidas", () => {
    const vistos = new Map<string, string>();
    const anotar = (id: string, origen: string) => {
      const previo = vistos.get(id);
      expect(previo, `colisión: ${origen} vs ${previo} → ${id}`).toBeUndefined();
      vistos.set(id, origen);
    };

    for (let ea = 1; ea <= 4_000; ea += 1) {
      anotar(buildEaImportedId(ea), `ea-tx ${ea}`);
      anotar(buildPaymentSourceTxId(ea), `payment ${ea}`);

      for (let seq = 1; seq <= 12; seq += 1) {
        anotar(buildEaAdjustmentImportedId(ea, seq), `adj ${ea}/${seq}`);
      }
    }

    for (const tx of TX_HOSTILES) {
      anotar(buildAgendaproImportedId(tx), `agendapro ${JSON.stringify(tx)}`);
    }

    expect(vistos.size).toBeGreaterThan(55_000);
  });

  it("las dos llaves de la MISMA cita nunca son iguales entre sí", () => {
    // `ea-appt:<id>` llavea la fila Payment de Strapi; `ea-tx:<id>` llavea el
    // movimiento de Actual. Son sistemas distintos y no pueden confundirse.
    for (let ea = 1; ea <= 5_000; ea += 1) {
      expect(buildPaymentSourceTxId(ea)).not.toBe(buildEaImportedId(ea));
      expect(parseImportedId(buildPaymentSourceTxId(ea))).toBeNull();
    }
  });
});

describe("AUDIT · round-trip estricto", () => {
  it("todo lo que el módulo construye se lee de vuelta idéntico", () => {
    for (let ea = 1; ea <= 3_000; ea += 7) {
      expect(parseImportedId(buildEaImportedId(ea))).toEqual({
        source: "ea",
        eaAppointmentId: ea,
        sequence: null,
      });

      for (let seq = 1; seq <= 9; seq += 1) {
        expect(parseImportedId(buildEaAdjustmentImportedId(ea, seq))).toEqual({
          source: "ea",
          eaAppointmentId: ea,
          sequence: seq,
        });
      }
    }

    for (const tx of TX_HOSTILES) {
      expect(parseImportedId(buildAgendaproImportedId(tx))).toEqual({
        source: "agendapro",
        txId: tx,
      });
    }
  });

  it("rechaza toda forma que el módulo no habría escrito", () => {
    const nunca = [
      "ea-tx:0",
      "ea-tx:-1",
      "ea-tx:007",
      "ea-tx:1.0",
      "ea-tx: 1",
      "ea-tx:1 ",
      "ea-tx:1e3",
      "ea-tx:",
      "ea-tx:1:adj0",
      "ea-tx:1:adj-1",
      "ea-tx:1:adj01",
      "ea-tx:1:adj1:adj2",
      "ea-tx:1:adj",
      "ea-tx:0x1",
      "ea-tx:Infinity",
      "ea-tx:NaN",
      "ea-appt:1",
      "EA-TX:1",
      "agendapro-tx:",
      "agendapro-tx:   ",
      "",
      " ea-tx:1",
    ];

    for (const value of nunca) {
      expect(parseImportedId(value), value).toBeNull();
    }
  });

  it("un id que no es cadena nunca se parsea", () => {
    for (const value of [null, undefined, 1, {}, [], true, Symbol("x"), BigInt(1)]) {
      expect(parseImportedId(value)).toBeNull();
    }
  });
});

describe("AUDIT · lo que no puede haber sido un id", () => {
  it("un id de cita fuera del entero positivo seguro revienta", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildEaImportedId(bad)).toThrow();
      expect(() => buildPaymentSourceTxId(bad)).toThrow();
      expect(() => buildEaAdjustmentImportedId(1, bad)).toThrow();
      expect(() => buildEaAdjustmentImportedId(bad, 1)).toThrow();
    }
  });

  it("un tx_id histórico vacío o solo espacios revienta", () => {
    for (const bad of ["", " ", "\t", "\n", "   \n  "]) {
      expect(() => buildAgendaproImportedId(bad)).toThrow();
    }
  });
});
