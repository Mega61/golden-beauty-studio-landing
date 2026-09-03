"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { ForbiddenError, requireCapability } from "@/lib/dal";
import { isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { IngestError } from "@/lib/ingest-client";
import {
  closeDay,
  recordAdjustment,
  retryAdjustmentPush,
  retryDayPush,
  type PushOutcome,
} from "@/jobs/day-close";

import { dayCloseDeps } from "./data";

/**
 * Las tres escrituras de Caja: cerrar el día, reintentar su push y registrar un
 * ajuste posterior al cierre.
 *
 * ## Devuelven el resultado, no lo lanzan
 *
 * Es el mismo criterio que la cuenta de servicio en `(panel)/hoy/actions.ts`.
 * Una excepción dentro de una Server Action llega al navegador como un digest
 * opaco en producción, y estas tres tienen desenlaces que la pantalla necesita
 * distinguir: "cerró y empujó", "cerró y el CRM no contestó", "no cerró porque
 * faltan tres cuentas". Los `redirect()` de Next sí tienen que propagarse, y de
 * eso se encarga `unstable_rethrow`.
 *
 * ## Las capacidades se vuelven a comprobar acá
 *
 * `caja:cerrar-dia` para cerrar y reintentar; `cuenta:corregir-tras-cierre`
 * —solo `owner`— para el ajuste. La pantalla ya esconde lo que no alcanza, pero
 * esconder un botón es cortesía con la usuaria: la Action que había detrás
 * sigue existiendo y se puede invocar sin él. Una técnica no llega ni a la
 * pantalla, y si escribe la URL de la Action tampoco pasa de acá.
 *
 * ## Ningún cálculo de plata
 *
 * Estas funciones no suman un peso. Los totales, la compuerta y el lote los
 * resuelve `jobs/day-close.ts`; el cuerpo que sale hacia Strapi, `lib/`.
 */

const FechaSchema = z.string().refine(isEaLocalDate, "La fecha tiene que ser YYYY-MM-DD");

/** Un peso más que esto es un dedo pegado, no una corrección. */
const MAX_PESOS = 99_999_999;

const AjusteSchema = z.object({
  eaAppointmentId: z.number().int().positive(),
  /** Con signo, y nunca cero: un ajuste de cero no es un movimiento. */
  delta: z.number().int().min(-MAX_PESOS).max(MAX_PESOS),
  reason: z.string().trim().min(3).max(500),
});

export type CerrarDiaResult =
  | { ok: false; kind: "permiso" | "config" | "compuerta" | "lote" | "error"; message: string }
  | {
      ok: true;
      /** `false` = el día ya estaba cerrado y esta llamada no creó nada. */
      created: boolean;
      message: string;
      push: PushOutcome;
    };

export type PushResult = { ok: boolean; message: string };

export type AjusteResult = { ok: boolean; message: string };

/** Cómo se le cuenta a la recepción qué pasó con el push. */
function pushMessage(push: PushOutcome): string {
  switch (push.state) {
    case "hecho":
      return `Se empujaron ${push.sent} movimientos al CRM.`;
    case "ya":
      return "El push ya se había hecho; no se repitió.";
    case "vacio":
      return "No había movimientos que empujar.";
    case "pendiente":
      return "Otro cierre simultáneo se está encargando del push. Refrescá en un momento.";
    case "apagado":
      return "El push está apagado (falta INGEST_URL): el día quedó cerrado sin empujar.";
    case "fallo":
      return push.retryable
        ? `El CRM no recibió el lote: ${push.message} Se puede reintentar.`
        : `El CRM rechazó el lote: ${push.message} Hay que revisarlo antes de reintentar.`;
  }
}

/**
 * Cerrar el día.
 *
 * La compuerta se vuelve a evaluar acá, en el servidor, con los datos del
 * momento del clic: entre que se pintó la pantalla y que alguien apretó el
 * botón pudo cerrarse una cuenta o aparecer una cita. Lo que la pantalla mostró
 * es información, no una autorización.
 */
export async function cerrarDia(fecha: string): Promise<CerrarDiaResult> {
  const parsed = FechaSchema.safeParse(fecha);
  if (!parsed.success) {
    return { ok: false, kind: "error", message: "La fecha del cierre llegó mal." };
  }
  const date = parsed.data as EaLocalDate;

  let session;
  try {
    session = await requireCapability("caja:cerrar-dia");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, kind: "permiso", message: "Tu rol no puede hacer el cierre diario." };
    }
    console.error("[caja] no se pudo verificar la sesión", error);
    return { ok: false, kind: "error", message: "No se pudo verificar la sesión." };
  }

  let deps;
  try {
    deps = dayCloseDeps();
  } catch (error) {
    unstable_rethrow(error);
    // `ingestConfigFromEnv()` lanza cuando hay URL sin secreto, y `getDb()`
    // cuando falta `DATABASE_URL`. Las dos son configuración, no un fallo
    // transitorio, y el nombre de la variable queda en el log del servidor.
    console.error("[caja] el panel está mal configurado", error);
    return {
      ok: false,
      kind: "config",
      message: "El panel no está bien configurado para cerrar el día. Avisá a la dueña.",
    };
  }

  let result;
  try {
    result = await closeDay(deps, { date, closedBy: session.userId });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[caja] no se pudo cerrar el día", error);
    return {
      ok: false,
      kind: "error",
      message: "No se pudo cerrar el día. Nada quedó a medias; vuelve a intentar.",
    };
  }

  revalidatePath("/caja");

  if (!result.ok) {
    if (result.reason === "lote") {
      return {
        ok: false,
        kind: "lote",
        message: `El día no se cerró porque el lote no se puede armar: ${result.message}`,
      };
    }
    const bloqueos = result.review.issues.filter((i) => i.blocks).length;
    const detalle =
      result.review.blockers.length > 0
        ? result.review.blockers.join(" ")
        : `Quedan ${bloqueos} ${bloqueos === 1 ? "pendiente" : "pendientes"} sin resolver.`;
    return { ok: false, kind: "compuerta", message: `El día no se cerró. ${detalle}` };
  }

  return {
    ok: true,
    created: result.created,
    message: result.created
      ? `Día cerrado: ${result.totals.count} cuentas.`
      : "El día ya estaba cerrado.",
    push: result.push,
  };
}

/**
 * Reintentar el push de un día ya cerrado.
 *
 * Reintentar no puede duplicar: el lote se rearma desde las mismas filas y cada
 * movimiento lleva el mismo `imported_id`, con el que Strapi y Actual Budget
 * deduplican. Por eso el botón existe incluso cuando nadie sabe si el primer
 * intento llegó.
 */
export async function reintentarPush(fecha: string): Promise<PushResult> {
  const parsed = FechaSchema.safeParse(fecha);
  if (!parsed.success) return { ok: false, message: "La fecha llegó mal." };

  try {
    await requireCapability("caja:cerrar-dia");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no puede empujar el cierre." };
    }
    console.error("[caja] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const outcome = await retryDayPush(dayCloseDeps(), {
      date: parsed.data as EaLocalDate,
    });
    revalidatePath("/caja");

    if (outcome.state === "sin-cierre") {
      return { ok: false, message: "Ese día todavía no está cerrado." };
    }
    return { ok: outcome.state !== "fallo", message: pushMessage(outcome) };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[caja] no se pudo reintentar el push", error);
    return { ok: false, message: "No se pudo reintentar el push." };
  }
}

/**
 * Registrar un ajuste sobre una cuenta ya congelada por el cierre.
 *
 * `delta` es la **diferencia con signo** respecto de lo ya empujado, no el
 * total nuevo: Actual importa el ajuste como un movimiento aparte y lo suma al
 * que ya tiene. Mandar el total nuevo duplicaría el ingreso de esa cita.
 *
 * Solo `owner`. Después del cierre los números ya salieron hacia Strapi y
 * Actual Budget, y editarlos en sitio los desincroniza en silencio.
 */
export async function registrarAjuste(input: {
  eaAppointmentId: number;
  delta: number;
  reason: string;
}): Promise<AjusteResult> {
  const parsed = AjusteSchema.safeParse(input);
  if (!parsed.success) {
    console.error("[caja] ajuste con forma inválida", parsed.error.issues);
    return { ok: false, message: "El ajuste llegó incompleto: hace falta el monto y el motivo." };
  }

  let session;
  try {
    session = await requireCapability("cuenta:corregir-tras-cierre");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Solo la dueña puede corregir una cuenta después del cierre." };
    }
    console.error("[caja] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const result = await recordAdjustment(dayCloseDeps(), {
      ...parsed.data,
      actorUserId: session.userId,
    });
    revalidatePath("/caja");
    revalidatePath("/hoy");

    if (!result.ok) return { ok: false, message: result.message };

    return {
      ok: result.push.state !== "fallo",
      message: `Ajuste ${result.sequence} registrado. ${pushMessage(result.push)}`,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof IngestError) {
      // No debería llegar acá —`recordAdjustment()` ya clasifica el fallo del
      // push— pero si llega, el renglón está escrito y el reintento es el
      // camino: nunca un ajuste nuevo.
      return { ok: false, message: `El ajuste quedó registrado sin empujar: ${error.message}` };
    }
    console.error("[caja] no se pudo registrar el ajuste", error);
    return { ok: false, message: "No se pudo registrar el ajuste." };
  }
}

/**
 * Reintentar el push de los ajustes de una cuenta.
 *
 * Reusa la secuencia y el delta que quedaron en la bitácora, así que manda el
 * mismo `imported_id` del primer intento. Sumar uno otra vez crearía un segundo
 * movimiento por la misma corrección.
 */
export async function reintentarAjuste(eaAppointmentId: number): Promise<PushResult> {
  if (!Number.isSafeInteger(eaAppointmentId) || eaAppointmentId <= 0) {
    return { ok: false, message: "El id de la cita llegó mal." };
  }

  try {
    await requireCapability("cuenta:corregir-tras-cierre");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Solo la dueña puede empujar un ajuste." };
    }
    console.error("[caja] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const outcome = await retryAdjustmentPush(dayCloseDeps(), { eaAppointmentId });
    revalidatePath("/caja");

    if (outcome.state === "sin-cuenta") {
      return { ok: false, message: "Esa cita no tiene una cuenta congelada por un cierre." };
    }
    return { ok: outcome.state !== "fallo", message: pushMessage(outcome) };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[caja] no se pudo reintentar el ajuste", error);
    return { ok: false, message: "No se pudo reintentar el ajuste." };
  }
}
