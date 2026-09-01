import { isDuplicateKeyError } from "../errors";
import type { WebhookEvent } from "../types";
import { toId, type Db } from "./shared";

export type RecordedEvent = {
  id: number;
  /** `true` = este cuerpo exacto ya se había recibido. No reprocesar. */
  duplicate: boolean;
};

/**
 * El rastro de los webhooks de EA.
 *
 * EA **no reintenta**, así que esta tabla no deduplica sus reenvíos (no
 * existen) sino los nuestros: el reconcile nocturno y el reproceso manual. Y es
 * lo único con lo que se depura un evento perdido, que acá es el modo de falla
 * esperado y no el raro.
 */
export function webhookEventRepository(db: Db) {
  return {
    /**
     * Anota un POST recibido, o reconoce que ya estaba.
     *
     * `duplicate: true` significa que llegó **el mismo cuerpo** para la misma
     * acción y entidad. Dos ediciones distintas de la misma cita tienen hashes
     * distintos y las dos se anotan, que es lo correcto: las dos hay que
     * procesarlas.
     *
     * Con `eaEntityId` en `null` (cuerpo malformado) nunca hay duplicado: MySQL
     * admite varios `NULL` en un índice único. Es deliberado — cada cuerpo roto
     * merece su propia fila, porque son las que se van a mirar a mano.
     */
    async record(input: {
      action: string;
      eaEntityId: number | null;
      bodyHash: string;
      receivedAt: Date;
    }): Promise<RecordedEvent> {
      try {
        const result = await db
          .insertInto("webhook_event")
          .values({
            action: input.action,
            ea_entity_id: input.eaEntityId,
            body_hash: input.bodyHash,
            received_at: input.receivedAt,
          })
          .executeTakeFirstOrThrow();
        return { id: toId(result.insertId), duplicate: false };
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        // `= NULL` no empareja nunca en SQL, así que el caso nulo se escribe
        // con `is`. En la práctica no se alcanza — un `ea_entity_id` nulo no
        // puede chocar contra el índice único — pero escribirlo mal acá sería
        // un `executeTakeFirstOrThrow` que revienta sin explicar por qué.
        let q = db
          .selectFrom("webhook_event")
          .select("id")
          .where("action", "=", input.action)
          .where("body_hash", "=", input.bodyHash);
        q =
          input.eaEntityId === null
            ? q.where("ea_entity_id", "is", null)
            : q.where("ea_entity_id", "=", input.eaEntityId);
        const existing = await q.executeTakeFirstOrThrow();
        return { id: existing.id, duplicate: true };
      }
    },

    async markProcessed(id: number, at: Date): Promise<void> {
      await db
        .updateTable("webhook_event")
        .set({ processed_at: at, error: null })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Deja el error y **no** marca la fila como procesada.
     *
     * Que quede sin `processed_at` es el punto: es lo que la hace aparecer en
     * `listUnprocessed()` y en Diagnóstico. Un evento que falló y se marca como
     * procesado es un evento perdido con buena cara.
     */
    async markFailed(id: number, error: string): Promise<void> {
      await db
        .updateTable("webhook_event")
        .set({ error })
        .where("id", "=", id)
        .execute();
    },

    async listUnprocessed(limit = 100): Promise<WebhookEvent[]> {
      return db
        .selectFrom("webhook_event")
        .selectAll()
        .where("processed_at", "is", null)
        .orderBy("received_at")
        .limit(limit)
        .execute();
    },

    async listForEntity(
      eaEntityId: number,
      limit = 50,
    ): Promise<WebhookEvent[]> {
      return db
        .selectFrom("webhook_event")
        .selectAll()
        .where("ea_entity_id", "=", eaEntityId)
        .orderBy("received_at", "desc")
        .limit(limit)
        .execute();
    },

    /** Diagnóstico: cuándo entró el último evento. Silencio prolongado = alarma. */
    async lastReceivedAt(): Promise<Date | undefined> {
      const row = await db
        .selectFrom("webhook_event")
        .select("received_at")
        .orderBy("received_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row?.received_at;
    },
  };
}

export type WebhookEventRepository = ReturnType<typeof webhookEventRepository>;
