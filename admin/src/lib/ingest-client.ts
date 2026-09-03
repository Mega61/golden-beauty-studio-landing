import "server-only";

import { safeBody } from "@/lib/ea";

import type { IngestPayment } from "./ingest-payload";

/**
 * El **único** lugar del panel que le habla a Strapi.
 *
 * Es deliberadamente delgado: recibe un lote ya armado por
 * `buildDayClosePayments()` / `buildIngestAdjustment()`, lo pone en un sobre, lo
 * manda y clasifica la respuesta en "entró" / "reintentá" / "está mal". No
 * calcula un peso, no lee la base, no sabe qué es un cierre diario.
 *
 * ## Qué quedó verificado y qué sigue abierto
 *
 * Leído del repo del CRM (`Mega61/golden-beauty-studio-crm`), que el plan daba
 * por no disponible:
 *
 * - ✅ **El esquema de `Payment`**
 *   (`src/api/payment/content-types/payment/schema.json`): `tx_id` (string,
 *   requerido, **UNIQUE** — es la llave de idempotencia), `sale_id`, `paid_at`
 *   (`YYYY-MM-DD`, requerido), `amount` (entero, requerido), `tip` (entero),
 *   `method` (enum `efectivo|transferencia|otro`, requerido), `payment_status`.
 *   `synced_to_actual` y `actual_txn_id` los maneja `actual-sync`, no nosotros.
 * - ✅ **El header de autenticación es `x-ingest-secret`**, con el valor de
 *   `INGEST_SHARED_SECRET`. No es Bearer.
 * - ✅ **`imported_id` no lo escribimos.** `automation/actual-sync/sync.mjs`
 *   lo construye con un prefijo fijo: `` `agendapro-tx:${tx_id}` ``, sin lógica
 *   por fuente. Así que lo que el panel controla es el `tx_id`, y de ahí sale
 *   la llave de Actual. Un `tx_id` de `ea-appt:501` produce
 *   `agendapro-tx:ea-appt:501` — feo, y **sin colisión posible** con los
 *   `tx_id` numéricos históricos de AgendaPro.
 * - ⚠ **No existe todavía una ruta JSON para pagos.**
 *   `POST /api/ingest/agendapro-transactions` lee `ctx.request.files` y parsea
 *   un XLSX de AgendaPro; la ruta JSON hermana
 *   (`POST /api/ingest/agendapro`) es de *visitas*, no de pagos. Hay que
 *   agregarla en el CRM sobre el `upsertPayment()` que ya existe, y eso es una
 *   decisión del dueño sobre otro sistema en producción: está propuesta, no
 *   aprobada.
 * - ⚠ Y por lo mismo, **el sobre del cuerpo es lo único que sigue sin
 *   verificar**: `{ payments: [...] }` espeja el `{ bookings: [...] }` de la
 *   ruta de visitas, que es el mejor precedente que hay. Vive en una constante.
 *
 * Lo que **no** existe en el esquema real y el plan suponía: `source`,
 * `source_tx_id`, `imported_id`, `ea_appointment_id`, `ea_provider_id`,
 * `ea_service_id`. La migración de "generalizar los campos con forma de Agenda
 * Pro" que el plan describe **no se hizo**. El cuerpo son los siete campos de
 * `Payment` y nada más.
 *
 * ## Por eso el envío se puede apagar, y hoy está apagado
 *
 * `INGEST_URL` ausente ⇒ `ingestConfigFromEnv()` devuelve `null` y el cierre
 * del día ocurre igual, registrando que no se empujó. **Mientras no exista la
 * ruta JSON, ése es el modo correcto de operación**: el cuerpo ya sale en la
 * forma buena, pero apuntar `INGEST_URL` a la ruta de hoy sería mandarle JSON a
 * un parser de XLSX. Cerrar la caja del estudio no puede depender de eso — un
 * día cerrado sin push se recupera con un reintento; un día que no se pudo
 * cerrar deja a la recepción sin su herramienta.
 *
 * ## Reintentar no duplica
 *
 * Cada pago viaja con su `tx_id`, que es UNIQUE en Strapi y de donde
 * `actual-sync` deriva el `imported_id` con el que Actual Budget deduplica. Así
 * que reenviar el **mismo lote** —después de un timeout, de un 502, o de un
 * push que nadie sabe si llegó— es seguro por construcción: no hace falta saber
 * si el primer intento entró. Lo que no es seguro es reenviar un lote
 * *distinto* con las mismas llaves, y de eso se encarga
 * `buildDayClosePayments()` armándolo siempre desde las mismas filas.
 */

// ── El contrato, en tres declaraciones ──────────────────────────────────────
//
// Dos verificadas contra el CRM y una (`INGEST_WRAPPER_KEY`) pendiente de que
// la ruta JSON exista. Nada más del panel las conoce.

/**
 * La clave del arreglo dentro del cuerpo.
 *
 * ⚠ Lo único sin verificar que queda: la ruta JSON de pagos todavía no existe
 * en el CRM. `payments` espeja el `bookings` de `POST /api/ingest/agendapro`.
 */
export const INGEST_WRAPPER_KEY = "payments";

/** Verificado: el header de autenticación del CRM. No es Bearer. */
export const INGEST_AUTH_HEADER = "x-ingest-secret";

/**
 * Una fila `Payment` de Strapi. **Exactamente** los campos de su esquema.
 *
 * `synced_to_actual` y `actual_txn_id` no están a propósito: los escribe
 * `actual-sync` y mandarlos sería decirle a Strapi algo que todavía no es
 * cierto. `sale_id` y `payment_status` tampoco: son opcionales y su semántica
 * aguas abajo no está verificada — un campo opcional que no entendemos se omite,
 * no se rellena con lo que parezca.
 */
export type StrapiPaymentBody = {
  /** UNIQUE. Es la llave de idempotencia, y de acá sale el `imported_id`. */
  tx_id: string;
  /** `YYYY-MM-DD`. Base caja: se cobra siempre el mismo día. */
  paid_at: string;
  /** Pesos enteros. Con signo en un ajuste. */
  amount: number;
  tip: number;
  method: IngestPayment["method"];
};

/**
 * `IngestPayment` (B1) → la fila `Payment` que el CRM espera.
 *
 * La traducción vive acá y no en `lib/ingest-payload.ts` por dos razones: ese
 * archivo es de otro paquete, y **es el lugar correcto de todos modos** — es la
 * forma del sistema de destino, y este archivo es el único que habla con él.
 *
 * Es un renombre y nada más: `source_tx_id` → `tx_id`, `paid_on` → `paid_at`.
 * No deriva ni compone ningún identificador. La llave la construye
 * `lib/ingest-id.ts` — incluida la de los ajustes, con
 * `buildPaymentAdjustmentSourceTxId()` — y llega acá ya armada.
 *
 * Antes esta función leía el sufijo `:adj<n>` de vuelta del `imported_id` y lo
 * reconcatenaba, porque `ingest-payload.ts` no ponía la secuencia en la llave.
 * Ya la pone.
 */
export function toStrapiPayment(payment: IngestPayment): StrapiPaymentBody {
  return {
    tx_id: payment.source_tx_id,
    paid_at: payment.paid_on,
    amount: payment.amount,
    tip: payment.tip,
    method: payment.method,
  };
}

/** El sobre. Ver la advertencia de `INGEST_WRAPPER_KEY`. */
function envelope(payments: readonly IngestPayment[]): unknown {
  return { [INGEST_WRAPPER_KEY]: payments.map(toStrapiPayment) };
}

// ── Configuración ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20_000;

export type IngestConfig = {
  url: string;
  secret: string;
  /** Inyectable para los tests. Por defecto el `fetch` del runtime. */
  fetch?: typeof fetch;
  /**
   * Más generoso que el de EA (10 s): esto es un lote de un día entero contra
   * un Strapi que quizá esté despertando, y se corre una vez al día, no en
   * cada render.
   */
  timeoutMs?: number;
};

type Env = Record<string, string | undefined>;

/**
 * La configuración, o `null` si el push está apagado.
 *
 * `null` es un estado legítimo y lo devuelve **solo** la ausencia de
 * `INGEST_URL`: es el interruptor. Una `INGEST_URL` presente con
 * `INGEST_SHARED_SECRET` ausente **lanza**, porque eso no es "apagado", es mal
 * configurado — y un POST sin credencial contra el CRM devolvería 401 en cada
 * cierre sin que nadie sepa por qué.
 */
export function ingestConfigFromEnv(env: Env = process.env): IngestConfig | null {
  const url = env.INGEST_URL?.trim();
  if (!url) return null;

  const secret = env.INGEST_SHARED_SECRET?.trim();
  if (!secret) {
    throw new IngestError(
      "INGEST_URL está configurada pero INGEST_SHARED_SECRET no. " +
        "Para apagar el push, quitá INGEST_URL.",
      { retryable: false },
    );
  }

  const timeoutMs = Number(env.INGEST_TIMEOUT_MS);

  return {
    url,
    secret,
    timeoutMs:
      Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

// ── Error ───────────────────────────────────────────────────────────────────

/**
 * Un push que no salió.
 *
 * `retryable` no es decoración: lo lee el cierre diario para decidir si Caja
 * ofrece "Reintentar" o si hay que arreglar algo antes. Un 400 reintentado cada
 * minuto es un contrato equivocado que nadie va a ver; un 502 tratado como
 * definitivo es un día de ingresos que no llega a Actual Budget.
 */
export class IngestError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  /** Cuerpo de la respuesta, con el secreto tachado y recortado. */
  readonly body?: string;

  constructor(
    message: string,
    context: { retryable: boolean; status?: number; body?: string; cause?: unknown },
  ) {
    super(message, context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = "IngestError";
    this.retryable = context.retryable;
    this.status = context.status;
    this.body = context.body;
  }
}

/**
 * ¿Vale la pena volver a intentar con este código?
 *
 * 408, 429 y todo 5xx sí: el CRM está caído, ocupado o lento y el lote sigue
 * siendo correcto. El resto de los 4xx no: el cuerpo que mandamos no le gusta,
 * y eso no lo arregla el tiempo — lo arregla corregir el contrato de este
 * archivo.
 */
function retryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

// ── Cliente ─────────────────────────────────────────────────────────────────

/** Lo que quedó registrado de un push que salió bien. */
export type IngestReceipt = {
  /** Cuántos movimientos se mandaron. */
  sent: number;
  /** El código HTTP. `0` cuando el lote estaba vacío y no se mandó nada. */
  status: number;
  at: Date;
};

export type IngestClient = {
  /** Manda el lote entero. Lanza `IngestError` si no salió. */
  push(payments: readonly IngestPayment[]): Promise<IngestReceipt>;
};

export function createIngestClient(config: IngestConfig): IngestClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async push(payments) {
      // Un lote vacío no se manda. No es un error —un día sin cuentas cerradas
      // existe— pero un POST con cero movimientos es una petición que solo
      // puede confundir el log del CRM.
      if (payments.length === 0) {
        return { sent: 0, status: 0, at: new Date() };
      }

      let response: Response;

      try {
        response = await doFetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            [INGEST_AUTH_HEADER]: config.secret,
          },
          body: JSON.stringify(envelope(payments)),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        // Red o timeout. **Siempre reintentable, y siempre incierto**: puede
        // que Strapi haya recibido el lote y la respuesta se haya perdido. Por
        // eso el reintento manda el mismo lote con las mismas llaves — ver el
        // encabezado.
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new IngestError(
          timedOut
            ? `El CRM no respondió en ${timeoutMs} ms al push de ${payments.length} movimientos`
            : `No se pudo alcanzar el CRM para el push de ${payments.length} movimientos`,
          { retryable: true, cause: error },
        );
      }

      if (!response.ok) {
        // El cuerpo se guarda tachado: un Strapi con `NODE_ENV=development`
        // imprime la excepción entera, y ahí puede venir de vuelta lo que le
        // mandamos, secreto incluido.
        const text = await response.text().catch(() => "");
        throw new IngestError(
          `El CRM respondió ${response.status} al push de ${payments.length} movimientos`,
          {
            retryable: retryableStatus(response.status),
            status: response.status,
            body: safeBody(text, config.secret),
          },
        );
      }

      // **La respuesta no se interpreta.** Un 2xx es todo lo que este archivo
      // sabe leer, porque la forma del cuerpo de respuesta está tan sin
      // verificar como la del de ida: parsear un `{ created: n }` que quizá no
      // exista produciría un `undefined` disfrazado de dato y un cierre que
      // dice "0 movimientos" habiendo empujado veinte.
      return { sent: payments.length, status: response.status, at: new Date() };
    },
  };
}
