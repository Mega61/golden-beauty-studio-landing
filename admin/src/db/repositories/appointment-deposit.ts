import type { AppointmentDeposit, AuthId, NewAppointmentDeposit, PaymentMethod } from "../types";
import type { Db } from "./shared";

/**
 * `appointment_deposit` (migración `034`): los adelantos de las citas.
 *
 * Lee y escribe filas, nada más. Cuánto queda disponible de un adelanto lo
 * dice `lib/deposits.ts`; qué viaja al CRM y con qué llave,
 * `lib/ingest-payload.ts`; cuándo, `jobs/deposits.ts`.
 */
export function appointmentDepositRepository(db: Db) {
  return {
    async findById(id: number): Promise<AppointmentDeposit | undefined> {
      return db.selectFrom("appointment_deposit").selectAll().where("id", "=", id).executeTakeFirst();
    },

    /** Inserta el adelanto y devuelve su id. */
    async insert(row: NewAppointmentDeposit): Promise<number> {
      const result = await db.insertInto("appointment_deposit").values(row).executeTakeFirstOrThrow();
      return Number(result.insertId);
    },

    /** Los adelantos de una cita, en el orden en que entraron. */
    async listByAppointment(eaAppointmentId: number): Promise<AppointmentDeposit[]> {
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .where("ea_appointment_id", "=", eaAppointmentId)
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    /** Los adelantos de varias citas a la vez (la agenda, Hoy). */
    async listByAppointments(eaAppointmentIds: readonly number[]): Promise<AppointmentDeposit[]> {
      if (eaAppointmentIds.length === 0) return [];
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .where("ea_appointment_id", "in", [...eaAppointmentIds])
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    /** Los adelantos de una clienta, por celular E.164. Para pasarlos de cita. */
    async listByPhone(phone: string): Promise<AppointmentDeposit[]> {
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .where("customer_phone", "=", phone)
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    /** Los más recientes, para Caja → Adelantos. */
    async listRecent(limit: number): Promise<AppointmentDeposit[]> {
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .orderBy("paid_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
    },

    /**
     * Los que movieron plata en `[from, to)`: entraron, o se devolvieron. Para
     * el día de Caja.
     */
    async listMovedBetween(from: Date, to: Date): Promise<AppointmentDeposit[]> {
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb("paid_at", ">=", from), eb("paid_at", "<", to)]),
            eb.and([eb("refunded_at", ">=", from), eb("refunded_at", "<", to)]),
          ]),
        )
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    /**
     * Lo que la sincronización tiene que mandar: adelantos pagados antes de
     * `to` que no viajaron, y devoluciones de antes de `to` de adelantos que ya
     * viajaron y cuyo ajuste todavía no salió. `from` acota por abajo para no
     * releer la historia entera cada noche.
     */
    async listPendingPush(from: Date, to: Date): Promise<AppointmentDeposit[]> {
      return db
        .selectFrom("appointment_deposit")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([
              eb("pushed_to_ingest_at", "is", null),
              eb("paid_at", ">=", from),
              eb("paid_at", "<", to),
            ]),
            eb.and([
              eb("pushed_to_ingest_at", "is not", null),
              eb("refunded_at", "is not", null),
              eb("refund_pushed_at", "is", null),
              eb("refunded_at", ">=", from),
              eb("refunded_at", "<", to),
            ]),
          ]),
        )
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    async markPushed(ids: number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("appointment_deposit")
        .set({ pushed_to_ingest_at: at })
        .where("id", "in", ids)
        .where("pushed_to_ingest_at", "is", null)
        .execute();
    },

    async markRefundPushed(ids: number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("appointment_deposit")
        .set({ refund_pushed_at: at })
        .where("id", "in", ids)
        .where("refund_pushed_at", "is", null)
        .execute();
    },

    /** La devolución. Una sola por adelanto: no pisa una que ya está. */
    async markRefunded(
      id: number,
      input: { amount: number; method: PaymentMethod; at: Date; by: AuthId; reason: string },
    ): Promise<boolean> {
      const result = await db
        .updateTable("appointment_deposit")
        .set({
          refunded_amount: input.amount,
          refund_method: input.method,
          refunded_at: input.at,
          refunded_by: input.by,
          refund_reason: input.reason,
        })
        .where("id", "=", id)
        .where("refunded_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    /** Pasar el adelanto a otra cita (la clienta canceló y volvió a agendar). */
    async moveToAppointment(
      id: number,
      eaAppointmentId: number,
      appointmentStartAt: Date | null,
    ): Promise<void> {
      await db
        .updateTable("appointment_deposit")
        .set({ ea_appointment_id: eaAppointmentId, appointment_start_at: appointmentStartAt })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Borra un adelanto que **todavía no viajó**: fue un error de digitación.
     * Uno que ya salió al CRM no se borra nunca (se devuelve).
     */
    async deleteUnpushed(id: number): Promise<boolean> {
      const result = await db
        .deleteFrom("appointment_deposit")
        .where("id", "=", id)
        .where("pushed_to_ingest_at", "is", null)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    },
  };
}

export type AppointmentDepositRepository = ReturnType<typeof appointmentDepositRepository>;
