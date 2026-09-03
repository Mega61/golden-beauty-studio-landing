"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { isEaLocalDate } from "@/lib/ea";

import { describeBlockers } from "./blockers";
import {
  fortnightOf,
  markFortnightPaid,
  markFortnightReviewed,
  runFortnight,
  type StatusChangeResult,
} from "@/jobs/commission-run";

/**
 * Las tres escrituras de Comisiones: liquidar la quincena, marcarla revisada y
 * marcarla pagada.
 *
 * ## Devuelven el resultado, no lo lanzan
 *
 * Mismo criterio que Caja. Una excepción dentro de una Server Action llega al
 * navegador como un digest opaco en producción, y estas tres tienen desenlaces
 * que la pantalla necesita distinguir: "liquidó y quedaron dos cuentas afuera",
 * "no se puede revisar porque faltan tres cierres de caja", "ya estaba pagada".
 * Los `redirect()` de Next sí tienen que propagarse, y de eso se encarga
 * `unstable_rethrow`.
 *
 * ## La capacidad se vuelve a comprobar acá
 *
 * `comisiones:administrar` —solo la dueña— para las tres. La pantalla ya
 * esconde los botones que una técnica no alcanza, pero esconder un botón es
 * cortesía con la usuaria: la Action que había detrás sigue existiendo y se
 * puede invocar sin él. Una técnica ve su liquidación; no la recalcula, no la
 * revisa y no la paga.
 *
 * ## Ningún cálculo de plata
 *
 * Estas funciones no suman un peso. El motor es `lib/commission.ts`, la corrida
 * es `jobs/commission-run.ts`, y la compuerta de la revisión vive ahí también,
 * en una función pura.
 */

const QuincenaSchema = z
  .string()
  .refine(isEaLocalDate, "La quincena se identifica con una fecha YYYY-MM-DD de su interior");

const ProviderSchema = z.number().int().positive();

export type LiquidarResult =
  | { ok: false; kind: "permiso" | "error"; message: string }
  | { ok: true; message: string; detail: string[] };

export type EstadoResult = { ok: boolean; message: string; blockers?: string[] };

/**
 * Liquidar la quincena: recalcular las comisiones de todas las técnicas.
 *
 * Es idempotente por diseño (ver `runFortnight()`), así que apretarlo dos veces
 * no paga el doble: reescribe las mismas filas. Por eso el botón puede existir
 * sin confirmación — lo que no se puede es tocar lo ya pagado, y de eso se
 * encarga el repositorio, no la buena memoria de quien aprieta.
 */
export async function liquidarQuincena(quincena: string): Promise<LiquidarResult> {
  const parsed = QuincenaSchema.safeParse(quincena);
  if (!parsed.success) {
    return { ok: false, kind: "error", message: "La quincena llegó mal." };
  }

  let session;
  try {
    session = await requireCapability("comisiones:administrar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return {
        ok: false,
        kind: "permiso",
        message: "Tu rol no puede liquidar comisiones.",
      };
    }
    console.error("[comisiones] no se pudo verificar la sesión", error);
    return { ok: false, kind: "error", message: "No se pudo verificar la sesión." };
  }

  try {
    const result = await runFortnight(
      { db: getDb() },
      { period: fortnightOf(parsed.data), actorUserId: session.userId },
    );

    revalidatePath("/comisiones");

    const detail: string[] = [];

    if (result.skipped.length > 0) {
      detail.push(
        result.skipped.length === 1
          ? "Una cuenta quedó por fuera: revísala abajo."
          : `${result.skipped.length} cuentas quedaron por fuera: revísalas abajo.`,
      );
    }
    if (result.flagged > 0) {
      detail.push(
        result.flagged === 1
          ? "Un renglón quedó marcado por falta de regla aplicable."
          : `${result.flagged} renglones quedaron marcados por falta de regla aplicable.`,
      );
    }
    if (result.written.frozen > 0) {
      detail.push(
        "Hay quincenas ya pagadas en el periodo: esas no se recalcularon, y está bien — " +
          "después de pagar no se ajusta nada.",
      );
    }
    if (result.written.dropped > 0) {
      detail.push(
        result.written.dropped === 1
          ? "Se quitó una comisión en borrador cuya cuenta dejó de cuadrar."
          : `Se quitaron ${result.written.dropped} comisiones en borrador cuyas cuentas dejaron de cuadrar.`,
      );
    }

    const tecnicas = result.runs.length;
    return {
      ok: true,
      message:
        tecnicas === 0
          ? "No hay nada que liquidar en esta quincena."
          : `Quincena liquidada: ${tecnicas} ${tecnicas === 1 ? "técnica" : "técnicas"}.`,
      detail,
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[comisiones] no se pudo liquidar la quincena", error);
    return {
      ok: false,
      kind: "error",
      message: "No se pudo liquidar la quincena. Nada quedó a medias; vuelve a intentar.",
    };
  }
}

function describeStatusChange(result: StatusChangeResult, hecho: string): EstadoResult {
  if (result.ok) {
    return {
      ok: true,
      message: result.already ? "Ya estaba así; no se cambió nada." : hecho,
    };
  }
  return {
    ok: false,
    message: result.message,
    // La frase se arma acá y no en el motor: el bloqueo viaja como dato para
    // que el cron no tenga que conocer el formato de fecha de la pantalla.
    blockers: result.blockers === undefined ? undefined : describeBlockers(result.blockers),
  };
}

/**
 * Marcar la quincena de una técnica como revisada.
 *
 * Es el paso que hace aceptable que pagar sea irreversible, y por eso tiene
 * compuerta: `markFortnightReviewed()` la vuelve a cobrar en el servidor con
 * los datos del momento del clic. Lo que la pantalla mostró es información, no
 * una autorización.
 */
export async function marcarRevisada(
  quincena: string,
  eaProviderId: number,
): Promise<EstadoResult> {
  const parsed = QuincenaSchema.safeParse(quincena);
  const provider = ProviderSchema.safeParse(eaProviderId);
  if (!parsed.success || !provider.success) {
    return { ok: false, message: "La quincena o la técnica llegaron mal." };
  }

  let session;
  try {
    session = await requireCapability("comisiones:administrar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no puede revisar liquidaciones." };
    }
    console.error("[comisiones] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const result = await markFortnightReviewed(
      { db: getDb() },
      {
        period: fortnightOf(parsed.data),
        eaProviderId: provider.data,
        actorUserId: session.userId,
      },
    );
    revalidatePath("/comisiones");
    return describeStatusChange(result, "Liquidación revisada. Ya se puede pagar.");
  } catch (error) {
    unstable_rethrow(error);
    console.error("[comisiones] no se pudo marcar como revisada", error);
    return { ok: false, message: "No se pudo marcar como revisada." };
  }
}

/**
 * Marcar la quincena de una técnica como pagada. **Esto la congela.**
 *
 * Después de esto no hay ajuste: así se trabaja hoy y el sistema lo respalda en
 * vez de pelearlo. Una corrección posterior no reescribe esta quincena; entra
 * en la siguiente.
 */
export async function marcarPagada(
  quincena: string,
  eaProviderId: number,
): Promise<EstadoResult> {
  const parsed = QuincenaSchema.safeParse(quincena);
  const provider = ProviderSchema.safeParse(eaProviderId);
  if (!parsed.success || !provider.success) {
    return { ok: false, message: "La quincena o la técnica llegaron mal." };
  }

  let session;
  try {
    session = await requireCapability("comisiones:administrar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no puede pagar liquidaciones." };
    }
    console.error("[comisiones] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  try {
    const result = await markFortnightPaid(
      { db: getDb() },
      {
        period: fortnightOf(parsed.data),
        eaProviderId: provider.data,
        actorUserId: session.userId,
      },
    );
    revalidatePath("/comisiones");
    return describeStatusChange(
      result,
      "Liquidación marcada como pagada. Queda cerrada: ya no se recalcula.",
    );
  } catch (error) {
    unstable_rethrow(error);
    console.error("[comisiones] no se pudo marcar como pagada", error);
    return { ok: false, message: "No se pudo marcar como pagada." };
  }
}
