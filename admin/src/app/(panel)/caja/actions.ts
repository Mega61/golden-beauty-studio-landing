"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { ForbiddenError, requireCapability } from "@/lib/dal";
import { isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { syncDay, type PushOutcome, type SyncDayResult } from "@/jobs/day-close";

import { dayCloseDeps } from "./data";

/**
 * La única escritura de Caja: **sincronizar ahora**.
 *
 * No hay cierre del día (desde 2026-11-09). Lo cobrado sale solo cada noche
 * (`jobs/nightly-sync.ts`); este botón hace lo mismo para un día, en el momento,
 * para cuando la dueña quiere ver la plata en Actual sin esperar a la noche.
 * Es la misma `syncDay()` que corre de noche, así que apretarlo dos veces —o
 * apretarlo y que después corra la noche— no manda nada dos veces.
 *
 * ## Devuelve el resultado, no lo lanza
 *
 * Una excepción dentro de una Server Action llega al navegador como un digest
 * opaco en producción. Los `redirect()` de Next sí tienen que propagarse, y de
 * eso se encarga `unstable_rethrow`.
 *
 * ## La capacidad se vuelve a comprobar acá
 *
 * `caja:cerrar-dia` (dueña y recepción). Esconder el botón es cortesía; la
 * Action sigue existiendo y se puede invocar sin él.
 */

const FechaSchema = z.string().refine(isEaLocalDate, "La fecha tiene que ser YYYY-MM-DD");

export type SyncResult = { ok: boolean; message: string };

/** Cómo se le cuenta a la recepción qué pasó con el envío. */
function pushMessage(push: PushOutcome): string {
  switch (push.state) {
    case "hecho":
      return `Listo: se enviaron ${push.sent} movimientos al CRM. Llegan a Actual en su próxima pasada.`;
    case "ya":
      return "Ya estaba todo sincronizado.";
    case "vacio":
      return "No había movimientos que enviar.";
    case "pendiente":
      return "Otra sincronización se está encargando. Refresca en un momento.";
    case "apagado":
      return "El envío al CRM está apagado (falta INGEST_URL): las cuentas quedaron listas y salen cuando se configure.";
    case "antes-del-corte":
      return `Este día es anterior al corte (${push.since}): su plata entró a Actual por Agenda Pro y no se manda.`;
    case "fallo":
      return push.retryable
        ? `El CRM no respondió: ${push.message} Se reintenta solo esta noche.`
        : `El CRM rechazó el envío: ${push.message} Hay que revisarlo.`;
  }
}

function syncMessage(result: SyncDayResult): SyncResult {
  const skipped =
    result.skipped.length === 0
      ? ""
      : ` ${result.skipped.length === 1 ? "1 cuenta no salió" : `${result.skipped.length} cuentas no salieron`} porque le falta algo: está en Pendientes.`;
  if (result.state === "nada") {
    return { ok: true, message: `No había nada nuevo que sincronizar.${skipped}` };
  }
  return { ok: result.push.state !== "fallo", message: `${pushMessage(result.push)}${skipped}` };
}

export async function sincronizarAhora(fecha: string): Promise<SyncResult> {
  const parsed = FechaSchema.safeParse(fecha);
  if (!parsed.success) return { ok: false, message: "La fecha llegó mal." };

  try {
    await requireCapability("caja:cerrar-dia");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no puede sincronizar la caja." };
    }
    console.error("[caja] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const result = await syncDay(dayCloseDeps(), { date: parsed.data as EaLocalDate });
    revalidatePath("/caja");
    revalidatePath("/hoy");
    return syncMessage(result);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[caja] no se pudo sincronizar", error);
    return { ok: false, message: "No se pudo sincronizar. Esta noche se intenta sola." };
  }
}
