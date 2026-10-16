import "server-only";

import { getDb } from "@/db/client";
import { auditLogRepository, serviceMapRepository } from "@/db/repositories";
import type { AuthId } from "@/db/types";
import { createEaClient } from "@/lib/ea/client";
import { forgetComboCompositions } from "@/lib/combo-source";

import type { CreatePayload } from "./diff";

/**
 * Las dos escrituras del catálogo que comparten la pantalla de Servicios y
 * `scripts/catalogo.js`: crear-y-vincular, y vincular uno que ya existe.
 *
 * Viven acá y no en `actions.ts` porque aquel archivo es `"use server"` —arrastra
 * la sesión, `revalidatePath` y la capacidad— y la consola no tiene ninguna de
 * las tres. Lo que sí tienen que compartir es el **orden** de las escrituras y la
 * bitácora, que es justo lo que no puede divergir entre los dos caminos.
 */

export type WriteActor = {
  /** `null` = el sistema (la consola), igual que el reconcile y el cierre. */
  actorUserId: AuthId | null;
  reason?: string | null;
};

export type CreateOutcome =
  | { ok: true; eaServiceId: number }
  /** EA no aceptó la creación. No se escribió nada. */
  | { ok: false; stage: "ea"; error: unknown }
  /**
   * EA lo creó y el vínculo falló. El servicio queda como `solo-en-ea` y se
   * recupera vinculándolo, **no** borrándolo.
   */
  | { ok: false; stage: "vincular"; eaServiceId: number; error: unknown };

/**
 * `POST /services` y, si sale, la fila de `service_map` + publicado + bitácora.
 *
 * El orden importa: al revés quedaría una fila del mapa apuntando a un servicio
 * inexistente, que es `mapa-roto` y ése no se arregla solo.
 */
export async function createAndLinkService(
  pricingId: string,
  payload: CreatePayload,
  actor: WriteActor,
): Promise<CreateOutcome> {
  let eaServiceId: number;
  try {
    // Se manda el payload entero y no campo por campo: enumerarlos fue cómo
    // `attendantsNumber` se quedó fuera y crear un servicio no funcionó nunca
    // contra una EA de verdad. `createPayload()` es puro y está testeado; que
    // decida él qué viaja.
    const created = await createEaClient().services.create(payload);
    eaServiceId = created.id;
  } catch (error) {
    return { ok: false, stage: "ea", error };
  }

  const at = new Date();
  try {
    const db = getDb();
    await serviceMapRepository(db).link(pricingId, eaServiceId);
    await serviceMapRepository(db).markPublished(pricingId, at);
    // El mapa vitrina↔EA acaba de cambiar. Sin esto, el combo recién creado
    // tardaría hasta un minuto en poder componerse desde la agenda.
    forgetComboCompositions();
    await auditLogRepository(db).append({
      actorUserId: actor.actorUserId,
      action: "catalogo.crear",
      entity: "service_map",
      entityId: pricingId,
      after: { ea_service_id: eaServiceId, ...payload },
      reason: actor.reason ?? null,
      at,
    });
  } catch (error) {
    return { ok: false, stage: "vincular", eaServiceId, error };
  }

  return { ok: true, eaServiceId };
}

/**
 * Vincular un id de la vitrina con un servicio de EA **que ya existe**. Lanza si
 * falla; el uno-a-uno lo cuida `uq_service_map_ea` en la base.
 */
export async function linkExistingService(
  pricingId: string,
  eaServiceId: number,
  actor: WriteActor,
): Promise<void> {
  const db = getDb();
  await serviceMapRepository(db).link(pricingId, eaServiceId);
  forgetComboCompositions();
  await auditLogRepository(db).append({
    actorUserId: actor.actorUserId,
    action: "catalogo.vincular",
    entity: "service_map",
    entityId: pricingId,
    after: { ea_service_id: eaServiceId },
    reason: actor.reason ?? null,
    at: new Date(),
  });
}
