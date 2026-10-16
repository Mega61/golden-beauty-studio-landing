import { describe, expect, it } from "vitest";

import {
  classifyPushError,
  classifyPushStatus,
  decideSubscriptionAction,
  MAX_CONSECUTIVE_FAILURES,
  planPrune,
} from "./prune";

describe("classifyPushStatus", () => {
  it("2xx es éxito", () => {
    for (const code of [200, 201, 202]) expect(classifyPushStatus(code)).toEqual({ kind: "ok" });
  });

  it("404 y 410 son una suscripción que ya no existe", () => {
    expect(classifyPushStatus(404).kind).toBe("gone");
    expect(classifyPushStatus(410).kind).toBe("gone");
  });

  it("400 y 413 son culpa nuestra, no del celular", () => {
    expect(classifyPushStatus(400).kind).toBe("ours");
    expect(classifyPushStatus(413).kind).toBe("ours");
  });

  it("401, 403, 429, 5xx y la red son fallas que suman", () => {
    for (const code of [401, 403, 429, 500, 502, 503]) {
      expect(classifyPushStatus(code)).toEqual({ kind: "failed", statusCode: code });
    }
    expect(classifyPushStatus(null)).toEqual({ kind: "failed", statusCode: null });
    expect(classifyPushStatus(undefined)).toEqual({ kind: "failed", statusCode: null });
    expect(classifyPushStatus(Number.NaN)).toEqual({ kind: "failed", statusCode: null });
  });
});

describe("classifyPushError", () => {
  it("lee el statusCode de un WebPushError", () => {
    expect(classifyPushError({ statusCode: 410, body: "" }).kind).toBe("gone");
    expect(classifyPushError({ statusCode: 503 }).kind).toBe("failed");
  });

  it("un error sin código es la red", () => {
    expect(classifyPushError(new Error("ECONNRESET"))).toEqual({ kind: "failed", statusCode: null });
    expect(classifyPushError("raro")).toEqual({ kind: "failed", statusCode: null });
    expect(classifyPushError({ statusCode: "410" })).toEqual({ kind: "failed", statusCode: null });
  });

  it("un «error» con 2xx no se cuenta como éxito", () => {
    expect(classifyPushError({ statusCode: 201 }).kind).toBe("failed");
  });
});

describe("decideSubscriptionAction", () => {
  it("un éxito reinicia, sin importar cuántas fallas traía", () => {
    expect(decideSubscriptionAction(9, { kind: "ok" })).toBe("mark-success");
  });

  it("404/410 borra en el acto, aun sin fallas previas", () => {
    expect(decideSubscriptionAction(0, { kind: "gone", statusCode: 410 })).toBe("delete");
  });

  it("lo que es culpa nuestra no toca la fila", () => {
    // Si contara, un payload mal armado podaría a todos los celulares en diez
    // reservas.
    expect(decideSubscriptionAction(MAX_CONSECUTIVE_FAILURES - 1, { kind: "ours", statusCode: 413 })).toBe(
      "keep",
    );
  });

  it("las fallas suman, y la que completa el máximo borra", () => {
    const fail = { kind: "failed", statusCode: 503 } as const;
    expect(decideSubscriptionAction(0, fail)).toBe("record-failure");
    expect(decideSubscriptionAction(MAX_CONSECUTIVE_FAILURES - 2, fail)).toBe("record-failure");
    expect(decideSubscriptionAction(MAX_CONSECUTIVE_FAILURES - 1, fail)).toBe("delete");
    expect(decideSubscriptionAction(MAX_CONSECUTIVE_FAILURES + 5, fail)).toBe("delete");
  });
});

describe("planPrune", () => {
  it("agrupa un envío en tres listas y deja fuera lo que no cambia", () => {
    const plan = planPrune([
      { id: 1, failureCount: 3, outcome: { kind: "ok" } },
      { id: 2, failureCount: 0, outcome: { kind: "gone", statusCode: 404 } },
      { id: 3, failureCount: 0, outcome: { kind: "failed", statusCode: null } },
      { id: 4, failureCount: MAX_CONSECUTIVE_FAILURES - 1, outcome: { kind: "failed", statusCode: 403 } },
      { id: 5, failureCount: 2, outcome: { kind: "ours", statusCode: 400 } },
    ]);
    expect(plan).toEqual({ success: [1], failure: [3], remove: [2, 4] });
  });

  it("vacío da vacío", () => {
    expect(planPrune([])).toEqual({ success: [], failure: [], remove: [] });
  });
});
