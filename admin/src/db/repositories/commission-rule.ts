import type { CommissionRule, NewCommissionRule } from "../types";
import { toId, type Db } from "./shared";

/**
 * Las reglas de comisión.
 *
 * El repositorio **no resuelve precedencia**. Devuelve las reglas vigentes y
 * `lib/commission.ts` decide cuál gana: es una función pura sobre una lista
 * (provider+service ▶ provider+category ▶ provider ▶ service ▶ category ▶
 * global, y ante empate la de `valid_from` más reciente), y como tal se testea
 * al 100 % de ramas. Resolverla en SQL la volvería intesteable sin una base.
 */
export function commissionRuleRepository(db: Db) {
  return {
    /**
     * Las reglas vigentes en una fecha de calendario (`"YYYY-MM-DD"`).
     *
     * `valid_to` es **inclusivo**: una regla que termina el 15 aplica al día 15
     * completo. Por eso `>=` y no `>`.
     */
    async listEffectiveOn(date: string): Promise<CommissionRule[]> {
      return db
        .selectFrom("commission_rule")
        .selectAll()
        .where("valid_from", "<=", date)
        .where((eb) =>
          eb.or([eb("valid_to", "is", null), eb("valid_to", ">=", date)]),
        )
        .orderBy("valid_from", "desc")
        .orderBy("id", "desc")
        .execute();
    },

    /**
     * Todas las reglas que tocan un periodo, vigentes o no.
     *
     * La liquidación de una quincena puede cruzar un cambio de tasa a mitad de
     * periodo: una cita del día 3 y otra del día 12 se evalúan cada una con la
     * regla vigente **ese** día. Trayendo el periodo entero, el motor resuelve
     * cita por cita sin volver a la base.
     */
    async listOverlappingPeriod(
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionRule[]> {
      return db
        .selectFrom("commission_rule")
        .selectAll()
        .where("valid_from", "<=", periodEnd)
        .where((eb) =>
          eb.or([eb("valid_to", "is", null), eb("valid_to", ">=", periodStart)]),
        )
        .orderBy("valid_from", "desc")
        .orderBy("id", "desc")
        .execute();
    },

    /** Para el editor de reglas. Orden estable, la más nueva arriba. */
    async listAll(): Promise<CommissionRule[]> {
      return db
        .selectFrom("commission_rule")
        .selectAll()
        .orderBy("valid_from", "desc")
        .orderBy("id", "desc")
        .execute();
    },

    async findById(id: number): Promise<CommissionRule | undefined> {
      return db
        .selectFrom("commission_rule")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async insert(row: NewCommissionRule): Promise<number> {
      const result = await db
        .insertInto("commission_rule")
        .values(row)
        .executeTakeFirstOrThrow();
      return toId(result.insertId);
    },

    /**
     * Cerrar una regla poniéndole fecha de fin.
     *
     * Es la única forma de "quitar" una regla: no hay borrado. Una regla que ya
     * se aplicó alguna vez está referenciada por `commission_entry` con `ON
     * DELETE RESTRICT`, porque borrarla dejaría comisiones ya pagadas sin poder
     * explicar de dónde salieron.
     */
    async closeAt(id: number, validTo: string): Promise<void> {
      await db
        .updateTable("commission_rule")
        .set({ valid_to: validTo })
        .where("id", "=", id)
        .execute();
    },
  };
}

export type CommissionRuleRepository = ReturnType<
  typeof commissionRuleRepository
>;
