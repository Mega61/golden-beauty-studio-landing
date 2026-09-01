import type { LegacyAppointment, NewLegacyAppointment } from "../types";
import type { Db } from "./shared";

/**
 * El histórico de Agenda Pro.
 *
 * Existe para que "clienta nueva" y "retención a 60 días" no empiecen a contar
 * desde cero el día del corte. Ambas definiciones se calculan sobre la **unión**
 * EA + legacy, y viven en `lib/metrics.ts`: acá solo se leen las filas de este
 * lado de la unión.
 */
export function legacyAppointmentRepository(db: Db) {
  return {
    /**
     * Alta idempotente por `source_id`.
     *
     * El import se puede correr dos veces sin duplicar el pasado, que es el
     * mismo principio que `ea_appointment_id` en `appointment_finance`. Y no
     * pisa lo ya importado: si el export cambia de forma entre dos corridas,
     * la primera versión es la que se conserva y la diferencia se mira a mano
     * antes de decidir.
     */
    async insertIfAbsent(rows: NewLegacyAppointment[]): Promise<number> {
      if (rows.length === 0) return 0;
      const result = await db
        .insertInto("legacy_appointment")
        .values(rows)
        .onDuplicateKeyUpdate({ source_id: (eb) => eb.ref("source_id") })
        .executeTakeFirstOrThrow();
      return Number(result.numInsertedOrUpdatedRows ?? 0);
    },

    async listByStartRange(from: Date, to: Date): Promise<LegacyAppointment[]> {
      return db
        .selectFrom("legacy_appointment")
        .selectAll()
        .where("started_at", ">=", from)
        .where("started_at", "<", to)
        .orderBy("started_at")
        .execute();
    },

    /**
     * La primera visita registrada de un teléfono en el histórico.
     *
     * La identidad de la clienta es el **teléfono en E.164**, nunca un correo
     * inventado. Es la misma llave con la que se deduplican las clientas en EA,
     * y por eso las dos mitades de la unión se pueden cruzar.
     */
    async firstVisitByPhone(phoneE164: string): Promise<Date | undefined> {
      const row = await db
        .selectFrom("legacy_appointment")
        .select("started_at")
        .where("client_phone_e164", "=", phoneE164)
        .orderBy("started_at")
        .limit(1)
        .executeTakeFirst();
      return row?.started_at;
    },
  };
}

export type LegacyAppointmentRepository = ReturnType<
  typeof legacyAppointmentRepository
>;
