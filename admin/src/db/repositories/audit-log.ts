import type { AuditLogRow, AuthId } from "../types";
import type { Db } from "./shared";

export type AuditEntry = {
  /** `null` = el sistema: el webhook, el reconcile, el cron de cierre. */
  actorUserId: AuthId | null;
  /** Verbo con espacio de nombres: `ticket.close`, `rule.save`, `run.pay`. */
  action: string;
  entity: string;
  entityId: string | number;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  at: Date;
};

/**
 * La bitácora.
 *
 * Append-only: solo `append` y lecturas. No hay update ni delete, y no es una
 * omisión — un log que se puede editar no es un log.
 */
export function auditLogRepository(db: Db) {
  return {
    /**
     * Anota una escritura del panel.
     *
     * `before` y `after` se serializan acá y no en el llamador para que el
     * formato sea uno solo: `null` cuando no aplica (un alta no tiene antes, una
     * baja no tiene después), y JSON en el resto de los casos. Un `"null"` de
     * texto y un `NULL` de SQL contando la misma historia sería exactamente el
     * tipo de ambigüedad que hace inútil una bitácora.
     */
    async append(entry: AuditEntry): Promise<void> {
      await db
        .insertInto("audit_log")
        .values({
          actor_user_id: entry.actorUserId,
          action: entry.action,
          entity: entry.entity,
          entity_id: String(entry.entityId),
          before_json:
            entry.before === undefined ? null : JSON.stringify(entry.before),
          after_json:
            entry.after === undefined ? null : JSON.stringify(entry.after),
          reason: entry.reason ?? null,
          created_at: entry.at,
        })
        .execute();
    },

    /** "Qué le pasó a esta cuenta". Lo más nuevo arriba. */
    async listForEntity(
      entity: string,
      entityId: string | number,
      limit = 100,
    ): Promise<AuditLogRow[]> {
      return db
        .selectFrom("audit_log")
        .selectAll()
        .where("entity", "=", entity)
        .where("entity_id", "=", String(entityId))
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
    },

    /** "Qué hizo esta persona en el periodo", para la revisión de la quincena. */
    async listByActor(
      actorUserId: AuthId,
      from: Date,
      to: Date,
      limit = 500,
    ): Promise<AuditLogRow[]> {
      return db
        .selectFrom("audit_log")
        .selectAll()
        .where("actor_user_id", "=", actorUserId)
        .where("created_at", ">=", from)
        .where("created_at", "<", to)
        .orderBy("created_at", "desc")
        .limit(limit)
        .execute();
    },
  };
}

export type AuditLogRepository = ReturnType<typeof auditLogRepository>;
