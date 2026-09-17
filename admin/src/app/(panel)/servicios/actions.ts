"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { auditLogRepository, serviceMapRepository } from "@/db/repositories";
import { EaApiError } from "@/lib/ea";
import { createEaClient } from "@/lib/ea/client";
import { requireCapability } from "@/lib/dal";

import { CREATE_BLOCKER_MESSAGE, createPayload, publishPayload } from "./diff";
import { loadServicesView } from "./data";

/**
 * Publicar la vitrina a Easy!Appointments. **En un solo sentido.**
 *
 * Tres reglas que están en el código y no en la disciplina de quien lo use:
 *
 * 1. **El monto no viaja desde el navegador.** La acción recibe un `pricingId` y
 *    nada más; el precio y la duración se recalculan en el servidor leyendo la
 *    vitrina de nuevo. Si el precio viniera en el formulario, cualquiera con la
 *    consola abierta podría publicar el número que quisiera en el catálogo con
 *    el que se cobra.
 * 2. **El payload lo arma `publishPayload()`**, que es puro y testeado, y lleva
 *    solo precio y duración. `service.color` es de solo escritura en la API de
 *    EA: un leer-modificar-guardar completo lo borraría del calendario.
 * 3. **Solo se publica lo que el diff marcó como desincronizado.** Si entre que
 *    se pintó la pantalla y se apretó el botón el servicio quedó al día, la
 *    acción no hace nada y lo dice.
 */

export type ActionResult = {
  ok: boolean;
  message: string;
};

export async function publicarPrecio(pricingId: string): Promise<ActionResult> {
  const session = await requireCapability("catalogo:publicar");

  const view = await loadServicesView();
  if (view.diff === null) {
    return {
      ok: false,
      message:
        "No se puede publicar sin haber podido leer las tres fuentes (vitrina, agenda y mapa).",
    };
  }

  const row = view.diff.rows.find((candidate) => candidate.pricingId === pricingId);
  if (!row) {
    return { ok: false, message: `"${pricingId}" ya no está en la vitrina.` };
  }

  const payload = publishPayload(row);
  if (payload === null) {
    return {
      ok: false,
      message:
        row.state === "al-dia"
          ? `"${pricingId}" ya estaba al día. No se escribió nada.`
          : `"${pricingId}" no se puede publicar: está ${row.state}.`,
    };
  }

  try {
    const ea = createEaClient();
    await ea.services.update(payload.eaServiceId, {
      price: payload.price,
      // La vitrina dice `null` cuando el ítem no ocupa tiempo propio; en ese
      // caso la duración de EA no se toca.
      ...(payload.duration === null ? {} : { duration: payload.duration }),
    });

    const at = new Date();
    const db = getDb();
    await serviceMapRepository(db).markPublished(pricingId, at);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "catalogo.publicar",
      entity: "service_map",
      entityId: pricingId,
      before: { price: row.eaPrice, duration: row.eaDuration },
      after: { price: payload.price, duration: payload.duration },
      at,
    });

    revalidatePath("/servicios");
    return { ok: true, message: `"${pricingId}" quedó publicado en la agenda.` };
  } catch (error) {
    return { ok: false, message: describeWriteFailure(error) };
  }
}

/**
 * Publicar todo lo desincronizado de una.
 *
 * Es el caso real del bump anual de precios: cambian veinte números en
 * `pricing.ts` y publicarlos de a uno es veinte oportunidades de saltarse uno.
 * Se recorre en serie y **se sigue después de un fallo**: publicar quince de
 * veinte y decir cuáles fallaron es mejor que abortar en el tercero y dejar el
 * catálogo a medias sin lista de lo que quedó pendiente.
 */
export async function publicarTodo(): Promise<ActionResult> {
  await requireCapability("catalogo:publicar");

  const view = await loadServicesView();
  if (view.diff === null) {
    return { ok: false, message: "No se puede publicar sin las tres fuentes." };
  }

  const pending = view.diff.publishable
    .map((row) => row.pricingId)
    .filter((id): id is string => id !== null);

  if (pending.length === 0) {
    return { ok: true, message: "No había nada desincronizado." };
  }

  const failed: string[] = [];
  for (const pricingId of pending) {
    const result = await publicarPrecio(pricingId);
    if (!result.ok) failed.push(pricingId);
  }

  revalidatePath("/servicios");
  return failed.length === 0
    ? { ok: true, message: `Se publicaron ${pending.length} servicios.` }
    : {
        ok: false,
        message: `Se publicaron ${pending.length - failed.length} de ${pending.length}. Quedaron pendientes: ${failed.join(", ")}.`,
      };
}

/**
 * Crear en la agenda un servicio que la vitrina tiene y EA no, y vincularlo.
 *
 * Es el caso de los cinco combos: `pricing.ts` los tiene con su precio y su
 * duración propios —más cortos y más baratos que la suma de sus partes— y en EA
 * no existen, así que hoy **un combo no se puede agendar como una sola cita**.
 *
 * ## El nombre lo escribe una persona, y por eso es un parámetro
 *
 * Es la única pieza que no está en la vitrina: los nombres viven en los
 * diccionarios de la landing, que esta app no importa. Derivarlo del id sería
 * inventar el texto que la clienta lee en su confirmación de cita. El precio y
 * la duración **no** viajan desde el navegador: se releen de la vitrina en el
 * servidor, igual que al publicar.
 *
 * ## Crear y vincular es un solo acto, y no es atómico
 *
 * Son dos sistemas: `POST /services` en EA y una fila en `service_map`. Si lo
 * segundo falla, el servicio queda creado en la agenda y sin vincular — y eso
 * es recuperable **desde la misma pantalla**, porque aparece como
 * `solo-en-ea` y el desplegable de Vincular lo ofrece. El mensaje lo dice con
 * esas palabras en vez de dejar a alguien adivinando si tiene que borrarlo allá.
 * El orden importa: al revés quedaría una fila del mapa apuntando a un servicio
 * inexistente, que es el estado `mapa-roto` y ése sí no se arregla solo.
 */
export async function crearServicio(
  pricingId: string,
  name: string,
): Promise<ActionResult> {
  const session = await requireCapability("catalogo:publicar");

  const view = await loadServicesView();
  if (view.diff === null) {
    return {
      ok: false,
      message: "No se puede crear sin haber podido leer las tres fuentes (vitrina, agenda y mapa).",
    };
  }

  const row = view.diff.rows.find((candidate) => candidate.pricingId === pricingId);
  if (!row) {
    return { ok: false, message: `"${pricingId}" ya no está en la vitrina.` };
  }

  const result = createPayload(row, name);
  if ("blocker" in result) {
    return { ok: false, message: `"${pricingId}" ${CREATE_BLOCKER_MESSAGE[result.blocker]}` };
  }

  const { payload } = result;

  let eaServiceId: number;
  try {
    const ea = createEaClient();
    const created = await ea.services.create({
      name: payload.name,
      price: payload.price,
      duration: payload.duration,
    });
    eaServiceId = created.id;
  } catch (error) {
    return { ok: false, message: describeWriteFailure(error) };
  }

  const at = new Date();
  try {
    const db = getDb();
    await serviceMapRepository(db).link(pricingId, eaServiceId);
    await serviceMapRepository(db).markPublished(pricingId, at);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "catalogo.crear",
      entity: "service_map",
      entityId: pricingId,
      after: { ea_service_id: eaServiceId, ...payload },
      at,
    });
  } catch (error) {
    return {
      ok: false,
      message:
        `"${payload.name}" se creó en la agenda (id ${eaServiceId}) pero no se pudo vincular. ` +
        `Aparece abajo como "solo en la agenda" y se puede vincular desde ahí; no hay que borrarlo. ` +
        describeWriteFailure(error),
    };
  }

  revalidatePath("/servicios");
  return {
    ok: true,
    message: `"${payload.name}" quedó creado en la agenda y vinculado a "${pricingId}".`,
  };
}

/**
 * Vincular un id de la vitrina con un servicio de EA **que ya existe**.
 *
 * Para lo que todavía no existe está `crearServicio()`, que lo crea y lo vincula
 * de una. Este camino es el de un servicio que alguien ya había creado a mano en
 * EA, o el de recuperar una creación que falló a la mitad.
 */
export async function vincularServicio(
  pricingId: string,
  eaServiceId: number,
): Promise<ActionResult> {
  const session = await requireCapability("catalogo:publicar");

  if (!Number.isSafeInteger(eaServiceId) || eaServiceId <= 0) {
    return { ok: false, message: "Hay que elegir un servicio de la agenda." };
  }

  try {
    const db = getDb();
    await serviceMapRepository(db).link(pricingId, eaServiceId);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "catalogo.vincular",
      entity: "service_map",
      entityId: pricingId,
      after: { ea_service_id: eaServiceId },
      at: new Date(),
    });
    revalidatePath("/servicios");
    return { ok: true, message: `"${pricingId}" quedó vinculado.` };
  } catch (error) {
    // El uno-a-uno lo cuida `uq_service_map_ea` en la base: si ese servicio ya
    // está tomado por otro id de vitrina, el choque llega hasta acá.
    return {
      ok: false,
      message:
        "No se pudo vincular. Puede que ese servicio de la agenda ya esté tomado por otro id de la vitrina. " +
        describeWriteFailure(error),
    };
  }
}

/**
 * Romper la correspondencia.
 *
 * Borra la fila del mapa y **nada más**: el servicio sigue en EA con sus citas
 * históricas colgando. Borrarlo allá sería destruir el pasado para limpiar el
 * presente.
 */
export async function desvincularServicio(pricingId: string): Promise<ActionResult> {
  const session = await requireCapability("catalogo:publicar");

  try {
    const db = getDb();
    const before = await serviceMapRepository(db).findByPricingId(pricingId);
    await serviceMapRepository(db).unlink(pricingId);
    await auditLogRepository(db).append({
      actorUserId: session.userId,
      action: "catalogo.desvincular",
      entity: "service_map",
      entityId: pricingId,
      before: before ? { ea_service_id: before.ea_service_id } : null,
      at: new Date(),
    });
    revalidatePath("/servicios");
    return {
      ok: true,
      message: `"${pricingId}" quedó desvinculado. El servicio sigue en la agenda.`,
    };
  } catch (error) {
    return { ok: false, message: describeWriteFailure(error) };
  }
}

function describeWriteFailure(error: unknown): string {
  if (error instanceof EaApiError) {
    if (error.kind === "not_found") {
      return "Ese servicio ya no existe en la agenda. Hay que desvincularlo antes de publicar.";
    }
    if (error.isConfiguration) {
      return "El panel no puede autenticarse contra la agenda. Es configuración, no un caído.";
    }
    return "La agenda no aceptó la escritura. No se cambió nada.";
  }
  return error instanceof Error ? error.message : String(error);
}
