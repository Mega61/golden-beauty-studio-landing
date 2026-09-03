import { describe, expect, it } from "vitest";

import type { CommissionEntryDetail } from "@/db/repositories/commission-entry";
import type { CommissionRun, CommissionRunStatus } from "@/db/types";

import {
  buildSettlements,
  settlementsBase,
  settlementsTotal,
  type SettlementNames,
} from "./settlement";

/**
 * Lo que la pantalla de Comisiones suma.
 *
 * Son sumas de enteros ya decididos, y por eso mismo tienen test: el total que
 * la dueña lee el 15 sale de acá, y un `+=` en el acumulador equivocado no se
 * ve mirando la pantalla — se ve cuando alguien reclama.
 */

const LINA = 3;
const SARA = 7;

const NOMBRES: SettlementNames = {
  providers: new Map([
    [LINA, "Lina"],
    [SARA, "Sara"],
  ]),
  services: new Map([
    [5, "Forrado en acrílico"],
    [31, "Diseño por uña"],
  ]),
};

let nextEntryId = 0;

function entrada(over: Partial<CommissionEntryDetail> = {}): CommissionEntryDetail {
  nextEntryId += 1;
  return {
    entryId: nextEntryId,
    eaProviderId: LINA,
    commissionRuleId: 1,
    baseAmount: 100_000,
    rateBp: 4000,
    amount: 40_000,
    status: "pending",
    commissionRunId: null,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-15",
    itemId: nextEntryId * 10,
    itemKind: "servicio",
    eaServiceId: 5,
    pricingId: null,
    qty: 1,
    note: null,
    financeId: 900,
    eaAppointmentId: 5001,
    // 2 p. m. del 8 de septiembre en la zona del proceso.
    appointmentStartAt: new Date(2026, 8, 8, 14, 0, 0),
    ...over,
  };
}

function liquidacion(
  over: Partial<CommissionRun> & { ea_provider_id: number },
): CommissionRun {
  return {
    id: 1,
    period_start: "2026-09-01",
    period_end: "2026-09-15",
    total: 40_000,
    status: "borrador" as CommissionRunStatus,
    reviewed_by: null,
    reviewed_at: null,
    paid_by: null,
    paid_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

describe("buildSettlements", () => {
  it("agrupa por técnica y por cita, y suma una sola vez", () => {
    const settlements = buildSettlements(
      [
        entrada({ itemId: 1, eaAppointmentId: 5001, baseAmount: 180_000, amount: 72_000 }),
        entrada({
          itemId: 2,
          eaAppointmentId: 5001,
          itemKind: "adicional",
          eaServiceId: 31,
          qty: 3,
          baseAmount: 24_000,
          amount: 9_600,
        }),
        entrada({ itemId: 3, eaAppointmentId: 5002, baseAmount: 100_000, amount: 40_000 }),
      ],
      [],
      NOMBRES,
    );

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      eaProviderId: LINA,
      name: "Lina",
      base: 304_000,
      amount: 121_600,
      appointments: 2,
      flagged: 0,
      status: null,
      runId: null,
    });
    expect(settlements[0].detail[0]).toMatchObject({
      eaAppointmentId: 5001,
      date: "2026-09-08",
      base: 204_000,
      amount: 81_600,
    });
    expect(settlements[0].detail[0].lines.map((line) => line.label)).toEqual([
      "Forrado en acrílico",
      "Diseño por uña",
    ]);
  });

  it("ordena por monto: arriba la que más hay que pagarle", () => {
    const settlements = buildSettlements(
      [
        entrada({ eaProviderId: SARA, amount: 40_000 }),
        entrada({ eaProviderId: LINA, amount: 227_600 }),
      ],
      [],
      NOMBRES,
    );
    expect(settlements.map((s) => s.name)).toEqual(["Lina", "Sara"]);
  });

  it("desempata por nombre para que el orden no baile entre recargas", () => {
    const settlements = buildSettlements(
      [
        entrada({ eaProviderId: SARA, amount: 40_000 }),
        entrada({ eaProviderId: LINA, amount: 40_000 }),
      ],
      [],
      NOMBRES,
    );
    expect(settlements.map((s) => s.name)).toEqual(["Lina", "Sara"]);
  });

  it("cuenta la cita del combo una vez por técnica, no una vez en total", () => {
    // El mismo renglón repartido entre dos técnicas: cada una tiene esa cita en
    // su desglose, y la suma de las dos es el 40 % del renglón completo.
    const settlements = buildSettlements(
      [
        entrada({
          itemId: 9,
          eaProviderId: LINA,
          eaAppointmentId: 5003,
          baseAmount: 150_000,
          amount: 60_000,
        }),
        entrada({
          itemId: 9,
          eaProviderId: SARA,
          eaAppointmentId: 5003,
          baseAmount: 100_000,
          amount: 40_000,
        }),
      ],
      [],
      NOMBRES,
    );
    expect(settlements.map((s) => [s.name, s.appointments, s.amount])).toEqual([
      ["Lina", 1, 60_000],
      ["Sara", 1, 40_000],
    ]);
  });

  it("marca el renglón sin regla y lo sube hasta la cita y la técnica", () => {
    const settlements = buildSettlements(
      [
        entrada({ itemId: 1, eaAppointmentId: 5004, amount: 40_000 }),
        entrada({
          itemId: 2,
          eaAppointmentId: 5004,
          itemKind: "manual",
          eaServiceId: null,
          commissionRuleId: null,
          rateBp: null,
          baseAmount: 0,
          amount: 0,
          note: "retoque de garantía",
        }),
      ],
      [],
      NOMBRES,
    );
    expect(settlements[0].flagged).toBe(1);
    expect(settlements[0].detail[0].flagged).toBe(true);
    expect(settlements[0].detail[0].lines[1]).toMatchObject({
      label: "retoque de garantía",
      flagged: true,
      amount: 0,
      rateBp: null,
    });
  });

  it("toma el estado de la liquidación guardada", () => {
    const settlements = buildSettlements(
      [entrada({ amount: 40_000 })],
      [liquidacion({ ea_provider_id: LINA, id: 12, status: "pagada", total: 40_000 })],
      NOMBRES,
    );
    expect(settlements[0]).toMatchObject({
      status: "pagada",
      runId: 12,
      runTotal: 40_000,
      stale: false,
    });
  });

  it("avisa cuando el total guardado ya no coincide con las entradas", () => {
    // Pasa cuando una cuenta cambió después de liquidar. Las dos cifras son
    // ciertas y la diferencia es lo que hay que resolver antes de pagar, así
    // que la pantalla no puede mostrar una sola y callarse la otra.
    const settlements = buildSettlements(
      [entrada({ amount: 30_400 })],
      [liquidacion({ ea_provider_id: LINA, total: 40_000 })],
      NOMBRES,
    );
    expect(settlements[0]).toMatchObject({ amount: 30_400, runTotal: 40_000, stale: true });
  });

  it("muestra la técnica que se liquidó en cero, que no es lo mismo que sin liquidar", () => {
    const settlements = buildSettlements(
      [],
      [liquidacion({ ea_provider_id: SARA, total: 0 })],
      NOMBRES,
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      name: "Sara",
      amount: 0,
      status: "borrador",
      appointments: 0,
      stale: false,
    });
  });

  it("una quincena vacía no inventa filas", () => {
    expect(buildSettlements([], [], NOMBRES)).toEqual([]);
  });

  describe("cuando EA no respondió", () => {
    const SIN_EA: SettlementNames = { providers: new Map(), services: new Map() };

    it("nombra a la técnica por su id en vez de dejar la fila muda", () => {
      const settlements = buildSettlements([entrada()], [], SIN_EA);
      expect(settlements[0].name).toBe("Técnica #3");
    });

    it("cae al id de la vitrina, y después al del servicio", () => {
      const settlements = buildSettlements(
        [
          entrada({ itemId: 1, eaServiceId: 5, pricingId: "acrylic-sculpted" }),
          entrada({ itemId: 2, eaServiceId: 77, pricingId: null }),
          entrada({ itemId: 3, eaServiceId: null, pricingId: null, itemKind: "adicional" }),
          entrada({ itemId: 4, eaServiceId: null, pricingId: null }),
        ],
        [],
        SIN_EA,
      );
      expect(settlements[0].detail[0].lines.map((line) => line.label)).toEqual([
        "acrylic-sculpted",
        "Servicio #77",
        "Adicional",
        "Servicio",
      ]);
    });

    it("y el renglón manual sin nota sigue teniendo rótulo", () => {
      const settlements = buildSettlements(
        [entrada({ itemKind: "manual", note: "   " })],
        [],
        SIN_EA,
      );
      expect(settlements[0].detail[0].lines[0].label).toBe("Renglón manual");
    });
  });

  it("deja la fecha en null cuando la cuenta no la tenía", () => {
    const settlements = buildSettlements(
      [entrada({ appointmentStartAt: null })],
      [],
      NOMBRES,
    );
    expect(settlements[0].detail[0].date).toBeNull();
  });

  it("fecha la cita por el reloj de pared, no por UTC", () => {
    // 8 p. m. del 15 en Bogotá es el 16 en UTC. Fechada en UTC, la última cita
    // de la quincena aparecería en la quincena siguiente.
    const settlements = buildSettlements(
      [entrada({ appointmentStartAt: new Date(2026, 8, 15, 20, 0, 0) })],
      [],
      NOMBRES,
    );
    expect(settlements[0].detail[0].date).toBe("2026-09-15");
  });
});

describe("los totales de la quincena", () => {
  it("suman lo que sale del estudio y sobre cuánto se calculó", () => {
    const settlements = buildSettlements(
      [
        entrada({ eaProviderId: LINA, baseAmount: 569_000, amount: 227_600 }),
        entrada({ eaProviderId: SARA, baseAmount: 100_000, amount: 40_000 }),
      ],
      [],
      NOMBRES,
    );
    expect(settlementsTotal(settlements)).toBe(267_600);
    expect(settlementsBase(settlements)).toBe(669_000);
  });

  it("una quincena sin liquidar vale cero, no null", () => {
    expect(settlementsTotal([])).toBe(0);
    expect(settlementsBase([])).toBe(0);
  });
});
