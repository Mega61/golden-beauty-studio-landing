import type { CommissionEntry, NewCommissionEntry } from "../types";
import type { Db } from "./shared";

/**
 * Las comisiones congeladas, renglón por renglón.
 */
export function commissionEntryRepository(db: Db) {
  return {
    async findByItemAndProvider(
      appointmentFinanceItemId: number,
      eaProviderId: number,
    ): Promise<CommissionEntry | undefined> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("appointment_finance_item_id", "=", appointmentFinanceItemId)
        .where("ea_provider_id", "=", eaProviderId)
        .executeTakeFirst();
    },

    /**
     * Escribe o reescribe la comisión de un renglón para una técnica.
     *
     * Recalcular una quincena en borrador tiene que ser repetible: correr el
     * motor dos veces sobre el mismo periodo da el mismo resultado y no una
     * segunda tanda de entradas. Lo garantiza `uq_ce_item_provider`, que
     * incluye el provider porque un combo trabajado por dos técnicas reparte el
     * mismo renglón entre las dos.
     *
     * **Una entrada ya pagada no se reescribe**, y devuelve `"paid"` para que
     * el llamador lo pueda decir en voz alta en vez de creer que actualizó algo.
     * Nada se ajusta después de pagar: así se trabaja hoy y el sistema lo
     * respalda en vez de pelearlo.
     *
     * La guarda es una lectura previa y no un `WHERE` atómico. Deja una ventana
     * teórica entre leer y escribir, y se acepta porque la compuerta de verdad
     * está un nivel más arriba: `commissionRunRepository.setStatus()` rechaza
     * tocar una liquidación `pagada`, y una entrada llega a `paid` solo por esa
     * vía. Dos recálculos simultáneos del mismo periodo no son un escenario
     * real — es una persona apretando un botón.
     */
    async upsert(row: NewCommissionEntry): Promise<"inserted" | "updated" | "paid"> {
      const existing = await db
        .selectFrom("commission_entry")
        .select(["id", "status"])
        .where(
          "appointment_finance_item_id",
          "=",
          row.appointment_finance_item_id,
        )
        .where("ea_provider_id", "=", row.ea_provider_id)
        .executeTakeFirst();

      if (!existing) {
        await db.insertInto("commission_entry").values(row).execute();
        return "inserted";
      }
      if (existing.status === "paid") return "paid";

      await db
        .updateTable("commission_entry")
        .set({
          commission_rule_id: row.commission_rule_id,
          base_amount: row.base_amount,
          rate_bp: row.rate_bp,
          amount: row.amount,
          period_start: row.period_start,
          period_end: row.period_end,
        })
        .where("id", "=", existing.id)
        .execute();
      return "updated";
    },

    /** La liquidación de una técnica en un periodo. Extremos inclusivos. */
    async listByProviderAndPeriod(
      eaProviderId: number,
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("ea_provider_id", "=", eaProviderId)
        .where("period_start", ">=", periodStart)
        .where("period_end", "<=", periodEnd)
        .orderBy("id")
        .execute();
    },

    async listByRun(commissionRunId: number): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("commission_run_id", "=", commissionRunId)
        .orderBy("id")
        .execute();
    },

    /**
     * Los renglones que quedaron **sin regla aplicable**.
     *
     * Cero marcado, no cero calculado: un cero silencioso es indistinguible de
     * un cero correcto, y esta consulta es la que hace que la marca se vea.
     * Sale en Diagnóstico y bloquea la revisión de la quincena.
     */
    async listUnmatchedInPeriod(
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionEntry[]> {
      return db
        .selectFrom("commission_entry")
        .selectAll()
        .where("commission_rule_id", "is", null)
        .where("period_start", ">=", periodStart)
        .where("period_end", "<=", periodEnd)
        .orderBy("id")
        .execute();
    },

    async attachToRun(ids: number[], commissionRunId: number): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("commission_entry")
        .set({ commission_run_id: commissionRunId })
        .where("id", "in", ids)
        .execute();
    },

    /** Marcar pagado es un efecto de pagar la liquidación, no un acto propio. */
    async markPaidByRun(commissionRunId: number): Promise<void> {
      await db
        .updateTable("commission_entry")
        .set({ status: "paid" })
        .where("commission_run_id", "=", commissionRunId)
        .execute();
    },

    /**
     * Suelta las entradas de una liquidación en borrador que se descarta.
     *
     * No las borra: la comisión calculada sobre un renglón sigue siendo cierta
     * aunque la liquidación se rehaga.
     */
    async detachFromRun(commissionRunId: number): Promise<void> {
      await db
        .updateTable("commission_entry")
        .set({ commission_run_id: null })
        .where("commission_run_id", "=", commissionRunId)
        .where("status", "=", "pending")
        .execute();
    },
  };
}

export type CommissionEntryRepository = ReturnType<
  typeof commissionEntryRepository
>;
