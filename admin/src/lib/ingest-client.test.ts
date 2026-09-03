import { describe, expect, it } from "vitest";

import {
  createIngestClient,
  IngestError,
  ingestConfigFromEnv,
  toStrapiPayment,
  INGEST_AUTH_HEADER,
  INGEST_WRAPPER_KEY,
} from "./ingest-client";
import {
  buildIngestAdjustment,
  buildIngestPayment,
  type FinanceForIngest,
} from "./ingest-payload";

/**
 * El cliente de ingest: lo único del panel que le habla a Strapi.
 *
 * Se fijan cuatro cosas:
 *
 * 1. **La traducción al esquema real de `Payment`**, leído del repo del CRM:
 *    los cinco campos que mandamos y ni uno más, y el `tx_id` —que es UNIQUE y
 *    de donde `actual-sync` deriva el `imported_id` de Actual Budget— distinto
 *    para una cita y para cada una de sus correcciones.
 * 2. El interruptor: sin `INGEST_URL` no hay cliente y el cierre sigue.
 * 3. Un fallo se clasifica bien en reintentable / definitivo. Un 400
 *    reintentado cada minuto es un contrato equivocado que nadie ve; un 502
 *    dado por definitivo es un día de ingresos que no llega a Actual Budget.
 * 4. El secreto no aparece en ningún mensaje de error.
 */

const SECRETO = "secreto-compartido-del-crm";

const FINANZA: FinanceForIngest = {
  eaAppointmentId: 41,
  amountCharged: 180_000,
  tip: 20_000,
  paymentMethod: "efectivo",
  paidOn: "2026-09-03",
  eaProviderId: 3,
  performedServiceId: 5,
};

const PAGO = buildIngestPayment(FINANZA);
const AJUSTE = buildIngestAdjustment(FINANZA, 20_000, 1);

/** Un `fetch` de mentira que registra lo que le pidieron. */
function fakeFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(input, init);
  };
  return { doFetch, calls };
}

function ok(body = "{}"): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── La traducción al esquema de Strapi ──────────────────────────────────────

describe("toStrapiPayment", () => {
  it("manda exactamente los cinco campos del esquema y ni uno más", () => {
    // `source`, `source_tx_id`, `imported_id`, `ea_appointment_id`,
    // `ea_provider_id` y `ea_service_id` **no existen** en el `Payment` real.
    // Mandarlos sería confiar en una migración que nunca se hizo.
    const body = toStrapiPayment(PAGO);

    expect(body).toEqual({
      tx_id: "ea-appt:41",
      paid_at: "2026-09-03",
      amount: 180_000,
      tip: 20_000,
      method: "efectivo",
    });
    // `synced_to_actual` y `actual_txn_id` los escribe `actual-sync`: mandarlos
    // sería afirmar algo que todavía no es cierto.
    expect(Object.keys(body).sort()).toEqual([
      "amount",
      "method",
      "paid_at",
      "tip",
      "tx_id",
    ]);
  });

  it("un ajuste lleva un tx_id propio, porque tx_id es UNIQUE", () => {
    // `source_tx_id` es el mismo para la cita y sus correcciones. Si el ajuste
    // reusara `ea-appt:41`, el upsert de Strapi **pisaría** el pago original y
    // Actual se quedaría con un solo movimiento por la cifra del ajuste.
    const body = toStrapiPayment(AJUSTE);

    expect(body.tx_id).toBe("ea-appt:41:adj1");
    expect(body.tx_id).not.toBe(toStrapiPayment(PAGO).tx_id);
    // Viaja el delta, no el total nuevo: Actual lo suma al que ya tiene.
    expect(body.amount).toBe(20_000);
    // Y la propina no se re-empuja con el ajuste.
    expect(body.tip).toBe(0);
  });

  it("dos ajustes de la misma cita no colisionan", () => {
    expect(toStrapiPayment(buildIngestAdjustment(FINANZA, 5_000, 2)).tx_id).toBe(
      "ea-appt:41:adj2",
    );
  });

  it("no compone la llave: la copia tal como se la dieron", () => {
    // La derivaba, leyendo el sufijo `:adj<n>` de vuelta del `imported_id`.
    // Ahora `ingest-payload.ts` la entrega armada y esta función solo renombra,
    // así que no hay ninguna forma de que produzca una llave que
    // `lib/ingest-id.ts` no haya producido.
    expect(toStrapiPayment(PAGO).tx_id).toBe(PAGO.source_tx_id);
    expect(toStrapiPayment(AJUSTE).tx_id).toBe(AJUSTE.source_tx_id);
  });
});

// ── El interruptor ──────────────────────────────────────────────────────────

describe("ingestConfigFromEnv", () => {
  it("sin INGEST_URL devuelve null: el push está apagado", () => {
    // No es un caso degradado. Hoy el contrato del cuerpo no está verificado, y
    // cerrar la caja del estudio no puede depender de eso.
    expect(ingestConfigFromEnv({})).toBeNull();
    expect(ingestConfigFromEnv({ INGEST_URL: "   " })).toBeNull();
  });

  it("con URL y sin secreto lanza: eso no es apagado, es mal configurado", () => {
    expect(() => ingestConfigFromEnv({ INGEST_URL: "https://crm/api/ingest" })).toThrow(
      IngestError,
    );
    expect(() =>
      ingestConfigFromEnv({ INGEST_URL: "https://crm/api/ingest", INGEST_SHARED_SECRET: " " }),
    ).toThrow(/INGEST_SHARED_SECRET/);
  });

  it("lee la URL, el secreto y el timeout", () => {
    const config = ingestConfigFromEnv({
      INGEST_URL: " https://crm/api/ingest ",
      INGEST_SHARED_SECRET: ` ${SECRETO} `,
      INGEST_TIMEOUT_MS: "5000",
    });

    expect(config).toEqual({
      url: "https://crm/api/ingest",
      secret: SECRETO,
      timeoutMs: 5000,
    });
  });

  it.each(["0", "-1", "abc", "1.5", ""])(
    "un timeout inválido (%s) cae en el default en vez de dejar la petición sin corte",
    (INGEST_TIMEOUT_MS) => {
      const config = ingestConfigFromEnv({
        INGEST_URL: "https://crm/api/ingest",
        INGEST_SHARED_SECRET: SECRETO,
        INGEST_TIMEOUT_MS,
      });
      expect(config?.timeoutMs).toBe(20_000);
    },
  );
});

// ── El envío ────────────────────────────────────────────────────────────────

describe("createIngestClient().push", () => {
  it("manda el lote con el header `x-ingest-secret` y el sobre", async () => {
    const { doFetch, calls } = fakeFetch(() => ok());
    const client = createIngestClient({ url: "https://crm/api/ingest", secret: SECRETO, fetch: doFetch });

    const receipt = await client.push([PAGO]);

    expect(receipt).toEqual({ sent: 1, status: 200, at: expect.any(Date) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://crm/api/ingest");
    expect(calls[0]?.init?.method).toBe("POST");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    // Verificado contra el CRM: el secreto va pelado en su propio header, no
    // como Bearer.
    expect(INGEST_AUTH_HEADER).toBe("x-ingest-secret");
    expect(headers[INGEST_AUTH_HEADER]).toBe(SECRETO);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    // Nada de `source` en el cuerpo: no existe en el esquema real.
    expect(body).toEqual({ [INGEST_WRAPPER_KEY]: [toStrapiPayment(PAGO)] });
  });

  it("un lote vacío no se manda", async () => {
    // Un día sin cuentas cerradas existe (un domingo); un POST de cero
    // movimientos solo puede confundir el log del CRM.
    const { doFetch, calls } = fakeFetch(() => ok());
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    const receipt = await client.push([]);

    expect(calls).toHaveLength(0);
    expect(receipt.sent).toBe(0);
    expect(receipt.status).toBe(0);
  });

  it("no interpreta el cuerpo de la respuesta", async () => {
    // La forma del cuerpo de respuesta está tan sin verificar como la del de
    // ida: parsear un `{ created: n }` que quizá no exista produciría un
    // `undefined` disfrazado de dato.
    const { doFetch } = fakeFetch(() => ok("esto no es json"));
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    await expect(client.push([PAGO])).resolves.toMatchObject({ sent: 1, status: 200 });
  });

  it("acepta cualquier 2xx", async () => {
    const { doFetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });
    await expect(client.push([PAGO])).resolves.toMatchObject({ status: 204 });
  });

  it.each([
    [500, true],
    [502, true],
    [503, true],
    [408, true],
    [429, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])("un %i se clasifica como reintentable=%s", async (status, retryable) => {
    const { doFetch } = fakeFetch(() => new Response("no", { status }));
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    await expect(client.push([PAGO])).rejects.toMatchObject({
      name: "IngestError",
      status,
      retryable,
    });
  });

  it("un fallo de red es reintentable, porque el lote sigue siendo correcto", async () => {
    const { doFetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    await expect(client.push([PAGO])).rejects.toMatchObject({ retryable: true });
  });

  it("un timeout dice cuántos milisegundos esperó", async () => {
    const { doFetch } = fakeFetch(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });
    const client = createIngestClient({
      url: "https://crm",
      secret: SECRETO,
      fetch: doFetch,
      timeoutMs: 1234,
    });

    await expect(client.push([PAGO])).rejects.toThrow(/1234 ms/);
  });

  it("tacha el secreto del cuerpo del error", async () => {
    // Un Strapi en modo desarrollo imprime la excepción entera, y ahí puede
    // venir de vuelta lo que le mandamos, credencial incluida.
    const { doFetch } = fakeFetch(
      () => new Response(`Error: bad token ${SECRETO} at line 3`, { status: 401 }),
    );
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    const error = await client.push([PAGO]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestError);
    const body = (error as IngestError).body ?? "";
    expect(body).not.toContain(SECRETO);
    expect(body).toContain("«token»");
  });

  it("reintentar el mismo lote manda los mismos tx_id", async () => {
    // Es la garantía de que un reintento no duplica: `tx_id` es UNIQUE en
    // Strapi y `actual-sync` deriva de él el `imported_id` con el que Actual
    // Budget deduplica. Así que no hace falta saber si el primer intento llegó.
    const cuerpos: string[] = [];
    const { doFetch } = fakeFetch((_input, init) => {
      cuerpos.push(String(init?.body));
      return ok();
    });
    const client = createIngestClient({ url: "https://crm", secret: SECRETO, fetch: doFetch });

    await client.push([PAGO]);
    await client.push([PAGO]);

    expect(cuerpos[0]).toBe(cuerpos[1]);
    expect(cuerpos[0]).toContain("ea-appt:41");
  });
});
