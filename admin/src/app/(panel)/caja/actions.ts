"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { ForbiddenError, requireCapability } from "@/lib/dal";
import { isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { dayBounds, syncDay, type PushOutcome, type SyncDayResult } from "@/jobs/day-close";
import { summarizeDepositSync, syncDeposits } from "@/jobs/deposits";
import { summarizeGiftSaleSync, syncGiftCardSales } from "@/jobs/gift-card-sales";

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
    const deps = dayCloseDeps();
    const result = await syncDay(deps, { date: parsed.data as EaLocalDate });
    // Las tarjetas regalo vendidas ese día salen con el mismo botón. Un fallo
    // acá no tapa lo de las cuentas: se dice al lado.
    const [from, to] = dayBounds(parsed.data as EaLocalDate);
    const gifts = await syncGiftCardSales(deps, { from, to }).catch((error: unknown) => {
      console.error("[caja] no se pudieron sincronizar las tarjetas regalo", error);
      return { state: "fallo", message: "no se pudieron enviar", retryable: true } as const;
    });
    // Y los adelantos que entraron (o se devolvieron) ese día.
    const deposits = await syncDeposits(deps, { from, to }).catch((error: unknown) => {
      console.error("[caja] no se pudieron sincronizar los adelantos", error);
      return { state: "fallo", message: "no se pudieron enviar", retryable: true } as const;
    });
    revalidatePath("/caja");
    revalidatePath("/hoy");
    revalidatePath("/caja/regalos");
    revalidatePath("/caja/adelantos");
    const base = syncMessage(result);
    const extra = [summarizeGiftSaleSync(gifts), summarizeDepositSync(deposits)].filter(
      (line): line is string => line !== null,
    );
    return extra.length === 0
      ? base
      : {
          ok: base.ok && gifts.state !== "fallo" && deposits.state !== "fallo",
          message: [base.message, ...extra.map((line) => `${line[0].toUpperCase()}${line.slice(1)}.`)].join(" "),
        };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[caja] no se pudo sincronizar", error);
    return { ok: false, message: "No se pudo sincronizar. Esta noche se intenta sola." };
  }
}
