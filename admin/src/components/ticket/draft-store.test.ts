import { describe, expect, it, vi } from "vitest";

import { emptyDraft, type TicketDraft } from "./draft";
import {
  draftKey,
  dropDraft,
  enqueue,
  flushOutbox,
  isRetryDue,
  listPending,
  newRequestId,
  outboxKey,
  parseDraft,
  readDraft,
  readPending,
  recordFailure,
  resolvePending,
  retryDelayMs,
  scopeKey,
  writeDraft,
  type DraftStorage,
  type PendingTicket,
  type SendOutcome,
} from "./draft-store";

/**
 * El almacenamiento de mentira.
 *
 * Un `Map` con la interfaz de `Storage` y dos interruptores para reproducir los
 * dos modos de falla que sí pasan en un celular: la cuota llena y el
 * almacenamiento bloqueado (Safari privado, cookies de sitio deshabilitadas),
 * donde **el acceso mismo lanza**.
 */
class FakeStorage implements DraftStorage {
  private readonly map = new Map<string, string>();
  failWrites = false;
  failEverything = false;

  get length(): number {
    if (this.failEverything) throw new Error("SecurityError");
    return this.map.size;
  }

  key(index: number): string | null {
    if (this.failEverything) throw new Error("SecurityError");
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    if (this.failEverything) throw new Error("SecurityError");
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failEverything || this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failEverything) throw new Error("SecurityError");
    this.map.delete(key);
  }

  /** Para escribir basura a mano, como haría una versión vieja del panel. */
  poke(key: string, value: string): void {
    this.map.set(key, value);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

const SCOPE = "user1";

function draft(id = 77, over: Partial<TicketDraft> = {}): TicketDraft {
  return { ...emptyDraft(id, 1, 1_000), ...over };
}

const OK = async (): Promise<SendOutcome> => ({ status: "ok" });
const CAIDO = async (): Promise<SendOutcome> => ({
  status: "reintentar",
  message: "Sin conexión",
});
const NO = async (): Promise<SendOutcome> => ({
  status: "rechazado",
  message: "Esta cita no es tuya.",
});

describe("scopeKey", () => {
  it("saca cualquier cosa que pudiera partir la clave", () => {
    expect(scopeKey("abc.def")).toBe("abcdef");
    expect(scopeKey("ok_1-2")).toBe("ok_1-2");
  });

  it("un alcance vacío no se convierte en un prefijo vacío", () => {
    expect(scopeKey("...")).toBe("anon");
    expect(scopeKey("")).toBe("anon");
  });
});

describe("borrador", () => {
  it("va y vuelve entero", () => {
    const s = new FakeStorage();
    const d = draft(77, { notes: "se rompió una", extras: { "10": 3 }, tip: 5_000 });
    expect(writeDraft(s, SCOPE, d)).toBe(true);
    expect(readDraft(s, SCOPE, 77)).toEqual(d);
  });

  it("no cruza alcances: la tablet es compartida", () => {
    const s = new FakeStorage();
    writeDraft(s, "lina", draft());
    expect(readDraft(s, "marcela", 77)).toBeNull();
    expect(readDraft(s, "lina", 77)).not.toBeNull();
  });

  it("una entrada corrupta se descarta y se borra en vez de arrastrarse", () => {
    const s = new FakeStorage();
    s.poke(draftKey(SCOPE, 77), "{no es json");
    expect(readDraft(s, SCOPE, 77)).toBeNull();
    expect(s.getItem(draftKey(SCOPE, 77))).toBeNull();
  });

  it("una versión que no reconoce se descarta entera: medio borrador es peor que ninguno", () => {
    const s = new FakeStorage();
    s.poke(draftKey(SCOPE, 77), JSON.stringify({ ...draft(), version: 0 }));
    expect(readDraft(s, SCOPE, 77)).toBeNull();
  });

  it("una escritura que no cabe devuelve false en vez de lanzar", () => {
    const s = new FakeStorage();
    s.failWrites = true;
    expect(writeDraft(s, SCOPE, draft())).toBe(false);
  });

  it("con el almacenamiento bloqueado nada lanza", () => {
    const s = new FakeStorage();
    s.failEverything = true;
    expect(writeDraft(s, SCOPE, draft())).toBe(false);
    expect(readDraft(s, SCOPE, 77)).toBeNull();
    expect(() => dropDraft(s, SCOPE, 77)).not.toThrow();
    expect(listPending(s, SCOPE)).toEqual([]);
  });

  it("se puede tirar", () => {
    const s = new FakeStorage();
    writeDraft(s, SCOPE, draft());
    dropDraft(s, SCOPE, 77);
    expect(readDraft(s, SCOPE, 77)).toBeNull();
  });
});

describe("parseDraft", () => {
  const base = draft();

  it("acepta lo que escribió esta misma versión", () => {
    expect(parseDraft(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });

  it.each([
    ["no es objeto", "hola"],
    ["es null", null],
    ["es arreglo", []],
    ["sin id", { ...base, eaAppointmentId: 0 }],
    ["id fraccionario", { ...base, eaAppointmentId: 1.5 }],
    ["servicio realizado que no es entero", { ...base, performedServiceId: "3" }],
    ["extras que no es objeto", { ...base, extras: [] }],
    ["manual que no es objeto", { ...base, manual: 7 }],
    ["manual sin monto entero", { ...base, manual: { note: "x", amount: 1.5 } }],
    ["total escrito que no es entero", { ...base, totalOverride: "1000" }],
  ])("rechaza cuando %s", (_que, raw) => {
    expect(parseDraft(raw)).toBeNull();
  });

  it("descarta cantidades y claves de adicional que no tienen forma de id", () => {
    const d = parseDraft({ ...base, extras: { "10": 3, "11": 0, abc: 2, "12": 1.5 } });
    expect(d?.extras).toEqual({ "10": 3 });
  });

  it("descarta un motivo y un método que no están en el enum", () => {
    const d = parseDraft({ ...base, varianceReasonCode: "porque-si", paymentMethod: "bitcoin" });
    expect(d?.varianceReasonCode).toBeNull();
    expect(d?.paymentMethod).toBeNull();
  });

  it("descarta un motivo y un método que ni siquiera son texto", () => {
    const d = parseDraft({ ...base, varianceReasonCode: 3, paymentMethod: {} });
    expect(d?.varianceReasonCode).toBeNull();
    expect(d?.paymentMethod).toBeNull();
  });

  it("conserva el motivo y el método válidos", () => {
    const d = parseDraft({
      ...base,
      varianceReasonCode: "cortesia",
      paymentMethod: "transferencia",
    });
    expect(d?.varianceReasonCode).toBe("cortesia");
    expect(d?.paymentMethod).toBe("transferencia");
  });

  it("una propina negativa vuelve como cero", () => {
    expect(parseDraft({ ...base, tip: -1 })?.tip).toBe(0);
  });

  it("los textos que no son cadena vuelven vacíos", () => {
    const d = parseDraft({ ...base, notes: 42, varianceReason: null });
    expect(d?.notes).toBe("");
    expect(d?.varianceReason).toBe("");
  });

  it("acepta el manual y el total escrito ausentes, no solo nulos", () => {
    const raw: Record<string, unknown> = { ...base };
    delete raw.manual;
    delete raw.totalOverride;
    const d = parseDraft(raw);
    expect(d?.manual).toBeNull();
    expect(d?.totalOverride).toBeNull();
  });

  it("conserva un renglón manual bien formado, nota incluida", () => {
    const d = parseDraft({ ...base, manual: { note: "garantía", amount: 0 } });
    expect(d?.manual).toEqual({ note: "garantía", amount: 0 });
  });

  it("un updatedAt que no es entero vuelve cero, no NaN", () => {
    expect(parseDraft({ ...base, updatedAt: "ayer" })?.updatedAt).toBe(0);
  });
});

describe("cola de salida", () => {
  it("encolar y leer de vuelta", () => {
    const s = new FakeStorage();
    const p = enqueue(s, SCOPE, draft(), "req-1", 5_000);
    expect(p.attempts).toBe(0);
    expect(readPending(s, SCOPE, 77)).toEqual(p);
    expect(listPending(s, SCOPE)).toHaveLength(1);
  });

  it("ordena por antigüedad: lo que lleva más esperando sale primero", () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(20), "b", 9_000);
    enqueue(s, SCOPE, draft(10), "a", 1_000);
    expect(listPending(s, SCOPE).map((p) => p.draft.eaAppointmentId)).toEqual([10, 20]);
  });

  it("desempata por id cuando dos se encolaron en el mismo milisegundo", () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(30), "b", 1_000);
    enqueue(s, SCOPE, draft(20), "a", 1_000);
    expect(listPending(s, SCOPE).map((p) => p.draft.eaAppointmentId)).toEqual([20, 30]);
  });

  it("una entrada de cola que no es un objeto se descarta", () => {
    const s = new FakeStorage();
    s.poke(outboxKey(SCOPE, 77), JSON.stringify("hola"));
    expect(readPending(s, SCOPE, 77)).toBeNull();
  });

  it("una entrada de cola corrupta se limpia y no rompe el listado", () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(), "req-1", 1_000);
    s.poke(outboxKey(SCOPE, 88), "{roto");
    expect(listPending(s, SCOPE)).toHaveLength(1);
    expect(s.getItem(outboxKey(SCOPE, 88))).toBeNull();
  });

  it("lee una entrada vieja sin clientRequestId sin descartarla", () => {
    const s = new FakeStorage();
    s.poke(outboxKey(SCOPE, 77), JSON.stringify({ draft: draft() }));
    const p = readPending(s, SCOPE, 77);
    expect(p?.clientRequestId).toBe("sin-id-77");
    expect(p?.attempts).toBe(0);
  });

  it("no cruza alcances", () => {
    const s = new FakeStorage();
    enqueue(s, "lina", draft(), "a", 1_000);
    expect(listPending(s, "marcela")).toEqual([]);
  });

  it("recordFailure cuenta el intento y guarda el motivo", () => {
    const s = new FakeStorage();
    const p = enqueue(s, SCOPE, draft(), "req-1", 1_000);
    const fallado = recordFailure(s, SCOPE, p, "Sin conexión", 2_000);
    expect(fallado.attempts).toBe(1);
    expect(fallado.lastAttemptAt).toBe(2_000);
    expect(readPending(s, SCOPE, 77)?.lastError).toBe("Sin conexión");
  });

  it("resolvePending puede conservar el borrador o llevárselo", () => {
    const s = new FakeStorage();
    writeDraft(s, SCOPE, draft());
    enqueue(s, SCOPE, draft(), "a", 1_000);

    resolvePending(s, SCOPE, 77, true);
    expect(readPending(s, SCOPE, 77)).toBeNull();
    expect(readDraft(s, SCOPE, 77)).not.toBeNull();

    enqueue(s, SCOPE, draft(), "b", 1_000);
    resolvePending(s, SCOPE, 77, false);
    expect(readDraft(s, SCOPE, 77)).toBeNull();
  });
});

describe("backoff", () => {
  it("crece y se planta en dos minutos", () => {
    expect(retryDelayMs(0)).toBe(5_000);
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(3)).toBe(40_000);
    expect(retryDelayMs(10)).toBe(120_000);
  });

  it("un contador negativo no da una espera negativa", () => {
    expect(retryDelayMs(-3)).toBe(5_000);
  });

  it("lo que nunca se intentó está listo ya", () => {
    const p: PendingTicket = {
      draft: draft(),
      clientRequestId: "a",
      queuedAt: 0,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };
    expect(isRetryDue(p, 0)).toBe(true);
  });

  it("respeta la espera y la deja pasar cuando se cumple", () => {
    const p: PendingTicket = {
      draft: draft(),
      clientRequestId: "a",
      queuedAt: 0,
      attempts: 1,
      lastAttemptAt: 1_000,
      lastError: "x",
    };
    expect(isRetryDue(p, 5_000)).toBe(false);
    expect(isRetryDue(p, 11_000)).toBe(true);
  });
});

describe("flushOutbox — el wifi del estudio", () => {
  it("lo que se manda bien deja las dos gavetas limpias", async () => {
    const s = new FakeStorage();
    writeDraft(s, SCOPE, draft());
    enqueue(s, SCOPE, draft(), "a", 1_000);

    const report = await flushOutbox(s, SCOPE, OK, { now: 2_000 });

    expect(report.sent).toEqual([77]);
    expect(listPending(s, SCOPE)).toEqual([]);
    expect(readDraft(s, SCOPE, 77)).toBeNull();
  });

  it("**lo que no llega se queda, y el borrador con él**", async () => {
    const s = new FakeStorage();
    const d = draft(77, { notes: "se rompió una y se repuso" });
    writeDraft(s, SCOPE, d);
    enqueue(s, SCOPE, d, "a", 1_000);

    const report = await flushOutbox(s, SCOPE, CAIDO, { now: 2_000 });

    expect(report.retrying).toEqual([{ eaAppointmentId: 77, message: "Sin conexión" }]);
    expect(readPending(s, SCOPE, 77)?.attempts).toBe(1);
    // Lo que la técnica escribió sigue ahí. Es el requisito entero.
    expect(readDraft(s, SCOPE, 77)?.notes).toBe("se rompió una y se repuso");
  });

  it("un rechazo del servidor sale de la cola pero conserva lo escrito", async () => {
    const s = new FakeStorage();
    writeDraft(s, SCOPE, draft());
    enqueue(s, SCOPE, draft(), "a", 1_000);

    const report = await flushOutbox(s, SCOPE, NO, { now: 2_000 });

    expect(report.rejected).toEqual([
      { eaAppointmentId: 77, message: "Esta cita no es tuya." },
    ]);
    expect(listPending(s, SCOPE)).toEqual([]);
    expect(readDraft(s, SCOPE, 77)).not.toBeNull();
  });

  it("un envío que lanza es reintentable, no un rechazo", async () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(), "a", 1_000);

    const report = await flushOutbox(
      s,
      SCOPE,
      async () => {
        throw new Error("Failed to fetch");
      },
      { now: 2_000 },
    );

    expect(report.retrying[0].message).toBe("Failed to fetch");
    expect(listPending(s, SCOPE)).toHaveLength(1);
  });

  it("un rechazo que no es Error tampoco pierde la cuenta", async () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(), "a", 1_000);

    const report = await flushOutbox(
      s,
      SCOPE,
      async () => {
        throw "cayó";
      },
      { now: 2_000 },
    );

    expect(report.retrying[0].message).toBe("No se pudo enviar");
  });

  it("respeta el backoff, y `force` lo salta", async () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(), "a", 0);
    await flushOutbox(s, SCOPE, CAIDO, { now: 0 });

    const send = vi.fn(OK);
    // Un segundo después todavía no toca.
    await flushOutbox(s, SCOPE, send, { now: 1_000 });
    expect(send).not.toHaveBeenCalled();

    // El botón "Reintentar" y el evento `online` no esperan.
    await flushOutbox(s, SCOPE, send, { now: 1_000, force: true });
    expect(send).toHaveBeenCalledOnce();
    expect(listPending(s, SCOPE)).toEqual([]);
  });

  it("manda de a una, en orden, y no en paralelo", async () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(20), "b", 2_000);
    enqueue(s, SCOPE, draft(10), "a", 1_000);

    const orden: number[] = [];
    let enVuelo = 0;

    await flushOutbox(
      s,
      SCOPE,
      async (p) => {
        enVuelo += 1;
        expect(enVuelo).toBe(1);
        await Promise.resolve();
        orden.push(p.draft.eaAppointmentId);
        enVuelo -= 1;
        return { status: "ok" };
      },
      { now: 3_000 },
    );

    expect(orden).toEqual([10, 20]);
  });

  it("una cuenta que sobrevivió a recargar la página se manda al volver la red", async () => {
    // Primera sesión: se escribe, se encola, falla.
    const disco = new FakeStorage();
    const d = draft(77, { extras: { "10": 3 }, performedServiceId: 2 });
    writeDraft(disco, SCOPE, d);
    enqueue(disco, SCOPE, d, "a", 0);
    await flushOutbox(disco, SCOPE, CAIDO, { now: 0 });

    // La pestaña se cerró. El disco es el mismo objeto, que es lo que
    // `localStorage` sería: sobrevive al recargar.
    expect(listPending(disco, SCOPE)).toHaveLength(1);
    expect(readDraft(disco, SCOPE, 77)?.extras).toEqual({ "10": 3 });

    // Segunda sesión: vuelve la red.
    const report = await flushOutbox(disco, SCOPE, OK, { now: 60_000 });
    expect(report.sent).toEqual([77]);
    expect(disco.keys()).toEqual([]);
  });

  it("sin `now` usa el reloj real, que es como lo llama el navegador", async () => {
    const s = new FakeStorage();
    enqueue(s, SCOPE, draft(), "a");
    const report = await flushOutbox(s, SCOPE, OK);
    expect(report.sent).toEqual([77]);
  });

  it("sin almacenamiento no hace nada y no lanza", async () => {
    const s = new FakeStorage();
    s.failEverything = true;
    const send = vi.fn(OK);
    const report = await flushOutbox(s, SCOPE, send, { now: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(report).toEqual({ sent: [], rejected: [], retrying: [] });
  });
});

describe("newRequestId", () => {
  it("no se repite entre dos envíos del mismo dedo", () => {
    const a = newRequestId(1_000);
    const b = newRequestId(1_000);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });
});
