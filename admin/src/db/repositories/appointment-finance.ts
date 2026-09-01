import { isDuplicateKeyError } from "../errors";
import type {
  AppointmentFinance,
  AppointmentFinanceUpdate,
  NewAppointmentFinance,
} from "../types";
import { toId, type Db } from "./shared";

export type EnsureResult = {
  row: AppointmentFinance;
  /** `false` = la fila ya existía. El webhook y el reconcile lo miran. */
  created: boolean;
};

/**
 * El encabezado de la cuenta. Es el libro de caja del estudio.
 */
export function appointmentFinanceRepository(db: Db) {
  return {
    async findByEaAppointmentId(
      eaAppointmentId: number,
    ): Promise<AppointmentFinance | undefined> {
      return db
        .selectFrom("appointment_finance")
        .selectAll()
        .where("ea_appointment_id", "=", eaAppointmentId)
        .executeTakeFirst();
    },

    async findById(id: number): Promise<AppointmentFinance | undefined> {
      return db
        .selectFrom("appointment_finance")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    /**
     * Crear la fila si no existe. **Es la idempotencia del snapshot de precio.**
     *
     * Hay dos caminos de escritura que compiten por la misma cita: el webhook
     * de EA y el reconcile nocturno. El reconcile no es el respaldo — es el
     * mecanismo principal, porque EA no reintenta y un panel caído diez minutos
     * pierde los eventos de esos diez minutos. Así que los dos van a pasar por
     * la misma cita, a veces al mismo tiempo.
     *
     * Se intenta el INSERT y se atrapa el choque contra `uq_af_ea_appointment`,
     * en vez de consultar primero. Un `SELECT` seguido de un `INSERT` deja una
     * ventana entre los dos, y dos peticiones simultáneas la encuentran. Dejar
     * que decida el índice único no tiene ventana.
     *
     * **No actualiza la fila existente.** Si la cita ya tenía snapshot, ese
     * snapshot se queda: revalorar una cita vieja con el precio de hoy es
     * exactamente la deriva de precios que el diseño evita.
     */
    async ensure(row: NewAppointmentFinance): Promise<EnsureResult> {
      try {
        const result = await db
          .insertInto("appointment_finance")
          .values(row)
          .executeTakeFirstOrThrow();
        const created = await db
          .selectFrom("appointment_finance")
          .selectAll()
          .where("id", "=", toId(result.insertId))
          .executeTakeFirstOrThrow();
        return { row: created, created: true };
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await db
          .selectFrom("appointment_finance")
          .selectAll()
          .where("ea_appointment_id", "=", row.ea_appointment_id)
          .executeTakeFirstOrThrow();
        return { row: existing, created: false };
      }
    },

    /**
     * La agenda de un rango. `from` inclusivo, `to` **exclusivo**.
     *
     * El borde exclusivo es la convención de todo el panel para rangos de
     * instantes, y evita la pregunta de si una cita que empieza a las 00:00 del
     * día siguiente entra o no. Los rangos de *calendario* (periodos de
     * quincena, `valid_to`) sí son inclusivos, y están tipados como `string`
     * para que las dos convenciones no se confundan.
     */
    async listByStartRange(
      from: Date,
      to: Date,
      opts: { eaProviderId?: number } = {},
    ): Promise<AppointmentFinance[]> {
      let q = db
        .selectFrom("appointment_finance")
        .selectAll()
        .where("appointment_start_at", ">=", from)
        .where("appointment_start_at", "<", to);
      if (opts.eaProviderId !== undefined) {
        q = q.where("ea_provider_id", "=", opts.eaProviderId);
      }
      return q.orderBy("appointment_start_at").orderBy("id").execute();
    },

    /**
     * Las cuentas del rango que todavía no se cerraron.
     *
     * Es la lista de pendientes de la pantalla de Caja, y la compuerta del
     * cierre diario: no se cierra el día con una cita completada sin cuenta.
     * Quién decide si "completada" cuenta es `lib/`, con el estado que trae EA;
     * acá solo se devuelven las filas sin `closed_at`.
     */
    async listOpenInRange(from: Date, to: Date): Promise<AppointmentFinance[]> {
      return db
        .selectFrom("appointment_finance")
        .selectAll()
        .where("appointment_start_at", ">=", from)
        .where("appointment_start_at", "<", to)
        .where("closed_at", "is", null)
        .orderBy("appointment_start_at")
        .orderBy("id")
        .execute();
    },

    /** Las cuentas congeladas por un cierre. La unidad de push a ingest. */
    async listByDayClose(dayCloseId: number): Promise<AppointmentFinance[]> {
      return db
        .selectFrom("appointment_finance")
        .selectAll()
        .where("day_close_id", "=", dayCloseId)
        .orderBy("id")
        .execute();
    },

    /**
     * Las citas de EA del rango que **no** tienen fila acá.
     *
     * No se puede responder desde este esquema: las citas viven en
     * `easyappointments` y se leen con otro usuario. El llamador (el reconcile)
     * trae la lista de ids desde la API de EA y pregunta cuáles ya conoce; la
     * diferencia son las que hay que crear.
     */
    async findExistingEaIds(eaAppointmentIds: number[]): Promise<Set<number>> {
      if (eaAppointmentIds.length === 0) return new Set();
      const rows = await db
        .selectFrom("appointment_finance")
        .select("ea_appointment_id")
        .where("ea_appointment_id", "in", eaAppointmentIds)
        .execute();
      return new Set(rows.map((r) => r.ea_appointment_id));
    },

    async update(id: number, patch: AppointmentFinanceUpdate): Promise<void> {
      await db
        .updateTable("appointment_finance")
        .set(patch)
        .where("id", "=", id)
        .execute();
    },

    /** Congela las cuentas del día bajo su cierre. */
    async attachToDayClose(ids: number[], dayCloseId: number): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("appointment_finance")
        .set({ day_close_id: dayCloseId })
        .where("id", "in", ids)
        .execute();
    },

    /**
     * Marca las cuentas de un cierre como empujadas.
     *
     * Va por cierre y no por cita porque el push es por cierre: Actual Budget
     * deduplica por `imported_id` y **no actualiza** el monto de una
     * transacción ya importada.
     */
    async markPushed(dayCloseId: number, at: Date): Promise<void> {
      await db
        .updateTable("appointment_finance")
        .set({ pushed_to_ingest_at: at })
        .where("day_close_id", "=", dayCloseId)
        .execute();
    },
  };
}

export type AppointmentFinanceRepository = ReturnType<
  typeof appointmentFinanceRepository
>;
