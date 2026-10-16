import { sql } from "kysely";

import type { AuthId } from "../types";
import type { Db } from "./shared";

/**
 * `push_subscription`: los navegadores que piden aviso de reservas web.
 *
 * Lee y escribe filas, nada más. Qué filas se podan después de un envío lo
 * decide `lib/push/prune.ts`; acá solo se aplica el plan.
 */

export type PushSubscriptionInput = {
  userId: AuthId;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
};

/** Una suscripción lista para mandarle, con el correo de su dueña. */
export type DeliverableSubscription = {
  id: number;
  userId: AuthId;
  email: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
};

export function pushSubscriptionRepository(db: Db) {
  return {
    /**
     * Alta o actualización por `endpoint`.
     *
     * El mismo celular que se vuelve a suscribir trae el mismo endpoint; la
     * `UNIQUE` lo convierte en un UPDATE. Si en ese celular ahora entró otra
     * persona (el teléfono del mostrador), la fila pasa a ser suya: los avisos
     * siguen a quien tiene la sesión en ese dispositivo, no a quien lo
     * suscribió primero. Las fallas se reinician porque la suscripción es
     * nueva a los ojos del servicio de push.
     *
     * Devuelve `true` si la fila no existía.
     */
    async upsert(input: PushSubscriptionInput): Promise<boolean> {
      const result = await db
        .insertInto("push_subscription")
        .values({
          user_id: input.userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          user_agent: input.userAgent,
        })
        .onDuplicateKeyUpdate({
          user_id: input.userId,
          p256dh: input.p256dh,
          auth: input.auth,
          user_agent: input.userAgent,
          failure_count: 0,
          last_failure_at: null,
        })
        .executeTakeFirst();
      // MySQL: 1 fila afectada = INSERT; 2 = UPDATE; 0 = UPDATE sin cambios.
      return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
    },

    /**
     * Baja de **este** dispositivo, y solo si es de quien la pide: una sesión
     * no puede apagar el celular de otra persona adivinando su endpoint.
     */
    async deleteForUser(userId: AuthId, endpoint: string): Promise<boolean> {
      const result = await db
        .deleteFrom("push_subscription")
        .where("user_id", "=", userId)
        .where("endpoint", "=", endpoint)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },

    async findForUser(
      userId: AuthId,
      endpoint: string,
    ): Promise<{ id: number; endpoint: string; p256dh: string; auth: string; failureCount: number } | undefined> {
      return db
        .selectFrom("push_subscription")
        .select(["id", "endpoint", "p256dh", "auth", "failure_count as failureCount"])
        .where("user_id", "=", userId)
        .where("endpoint", "=", endpoint)
        .executeTakeFirst();
    },

    /**
     * Todas, con el correo de la cuenta. El rol **no** se resuelve acá: lo
     * decide el envío contra `allowed_user` con la misma normalización del
     * DAL, para que quien salió de Equipo deje de recibir en el aviso
     * siguiente aunque su fila siga ahí.
     */
    async listDeliverable(): Promise<DeliverableSubscription[]> {
      return db
        .selectFrom("push_subscription")
        .innerJoin("user", "user.id", "push_subscription.user_id")
        .select([
          "push_subscription.id as id",
          "push_subscription.user_id as userId",
          "user.email as email",
          "push_subscription.endpoint as endpoint",
          "push_subscription.p256dh as p256dh",
          "push_subscription.auth as auth",
          "push_subscription.failure_count as failureCount",
        ])
        .execute();
    },

    async markSuccess(ids: readonly number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("push_subscription")
        .set({ failure_count: 0, last_success_at: at })
        .where("id", "in", [...ids])
        .execute();
    },

    async recordFailure(ids: readonly number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("push_subscription")
        .set({ failure_count: sql<number>`failure_count + 1`, last_failure_at: at })
        .where("id", "in", [...ids])
        .execute();
    },

    async deleteByIds(ids: readonly number[]): Promise<void> {
      if (ids.length === 0) return;
      await db.deleteFrom("push_subscription").where("id", "in", [...ids]).execute();
    },
  };
}

export type PushSubscriptionRepository = ReturnType<typeof pushSubscriptionRepository>;
