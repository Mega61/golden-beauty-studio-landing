/**
 * Qué hacer con una suscripción después de intentar mandarle un aviso.
 *
 * Pura, porque la decisión que importa —¿se borra esta fila?— se equivoca en
 * las dos direcciones y ninguna hace ruido: borrar de más deja a la dueña sin
 * avisos sin que nadie se entere; borrar de menos acumula filas muertas que se
 * reintentan en cada reserva para siempre.
 *
 * ## Las reglas
 *
 * | Respuesta del servicio de push | Qué significa | Qué se hace |
 * | --- | --- | --- |
 * | 2xx | Aceptado | Éxito: `failure_count = 0`, `last_success_at = ahora` |
 * | 404 / 410 | La suscripción ya no existe (desinstaló, borró datos, revocó) | **Se borra ya** |
 * | 400 / 413 | El pedido estaba mal **de nuestro lado** (payload, cabeceras) | Nada: no es culpa del celular y contarlo podaría a todos |
 * | 401 / 403 / 429 / 5xx / red | Llaves VAPID que no casan, cuota, caída del servicio | Suma una falla; con `MAX_CONSECUTIVE_FAILURES` seguidas, se borra |
 *
 * 403 cuenta como falla y no como "nuestra" porque es lo que devuelven FCM y
 * Apple cuando la suscripción se creó con otra llave VAPID — y esa
 * suscripción no se recupera nunca. Diez fallas seguidas son diez reservas sin
 * un solo éxito: si fuera una caída del servicio, alguna habría pasado.
 */

export const MAX_CONSECUTIVE_FAILURES = 10;

export type PushOutcome =
  | { kind: "ok" }
  | { kind: "gone"; statusCode: number }
  | { kind: "ours"; statusCode: number }
  | { kind: "failed"; statusCode: number | null };

/**
 * Lee el resultado de `webpush.sendNotification`: el `statusCode` de un
 * éxito, o el de un `WebPushError`. Un error sin código es la red.
 */
export function classifyPushStatus(statusCode: number | null | undefined): PushOutcome {
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    return { kind: "failed", statusCode: null };
  }
  if (statusCode >= 200 && statusCode < 300) return { kind: "ok" };
  if (statusCode === 404 || statusCode === 410) return { kind: "gone", statusCode };
  if (statusCode === 400 || statusCode === 413) return { kind: "ours", statusCode };
  return { kind: "failed", statusCode };
}

/** `classifyPushStatus` sobre lo que haya lanzado la librería. */
export function classifyPushError(error: unknown): PushOutcome {
  const code =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode: unknown }).statusCode
      : null;
  const outcome = classifyPushStatus(typeof code === "number" ? code : null);
  // Un "error" con 2xx no existe; si llegara, es un fallo raro de la librería.
  return outcome.kind === "ok" ? { kind: "failed", statusCode: code as number } : outcome;
}

export type SubscriptionAction = "mark-success" | "delete" | "record-failure" | "keep";

export function decideSubscriptionAction(
  previousFailures: number,
  outcome: PushOutcome,
): SubscriptionAction {
  switch (outcome.kind) {
    case "ok":
      return "mark-success";
    case "gone":
      return "delete";
    case "ours":
      return "keep";
    case "failed":
      return previousFailures + 1 >= MAX_CONSECUTIVE_FAILURES ? "delete" : "record-failure";
  }
}

export type PrunePlan = {
  success: number[];
  failure: number[];
  remove: number[];
};

/** El lote de decisiones de un envío, agrupado para tres escrituras y no N. */
export function planPrune(
  results: readonly { id: number; failureCount: number; outcome: PushOutcome }[],
): PrunePlan {
  const plan: PrunePlan = { success: [], failure: [], remove: [] };
  for (const r of results) {
    const action = decideSubscriptionAction(r.failureCount, r.outcome);
    if (action === "mark-success") plan.success.push(r.id);
    else if (action === "record-failure") plan.failure.push(r.id);
    else if (action === "delete") plan.remove.push(r.id);
  }
  return plan;
}
