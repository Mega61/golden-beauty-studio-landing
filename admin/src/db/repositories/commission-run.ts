import type {
  AuthId,
  CommissionRun,
  CommissionRunStatus,
  Cop,
  NewCommissionRun,
} from "../types";
import { toId, type Db } from "./shared";

/**
 * Se intentó modificar una liquidación ya pagada.
 *
 * Es un tipo de error propio y no un `Error` genérico porque la UI tiene que
 * poder distinguirlo: "esta quincena ya se pagó y no se ajusta" es un mensaje,
 * no una falla del sistema.
 */
export class PaidCommissionRunError extends Error {
  constructor(public readonly runId: number) {
    super(
      `La liquidación ${runId} ya está pagada y es inmutable. ` +
        "Nada se ajusta después de pagar: la corrección va en la quincena siguiente.",
    );
    this.name = "PaidCommissionRunError";
  }
}

/**
 * Las liquidaciones quincenales.
 *
 * La inmutabilidad de `pagada` se hace cumplir acá y no con un trigger. Un
 * trigger sería invisible desde el código y no se puede crear de forma
 * idempotente en MySQL, así que rompería el set de migraciones. Que la regla
 * viva en un método que se puede leer y testear es preferible a que viva en un
 * lugar donde nadie la va a encontrar.
 */
export function commissionRunRepository(db: Db) {
  return {
    async findById(id: number): Promise<CommissionRun | undefined> {
      return db
        .selectFrom("commission_run")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    async findByProviderAndPeriod(
      eaProviderId: number,
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionRun | undefined> {
      return db
        .selectFrom("commission_run")
        .selectAll()
        .where("ea_provider_id", "=", eaProviderId)
        .where("period_start", "=", periodStart)
        .where("period_end", "=", periodEnd)
        .executeTakeFirst();
    },

    /** Todas las liquidaciones de un periodo, para la pantalla de la quincena. */
    async listByPeriod(
      periodStart: string,
      periodEnd: string,
    ): Promise<CommissionRun[]> {
      return db
        .selectFrom("commission_run")
        .selectAll()
        .where("period_start", "=", periodStart)
        .where("period_end", "=", periodEnd)
        .orderBy("ea_provider_id")
        .execute();
    },

    async insert(row: NewCommissionRun): Promise<number> {
      const result = await db
        .insertInto("commission_run")
        .values(row)
        .executeTakeFirstOrThrow();
      return toId(result.insertId);
    },

    /**
     * Reescribe el total de un borrador.
     *
     * Solo de un borrador: una vez revisada, el total que se revisó es el que
     * se paga. Cambiarlo por debajo convertiría la revisión en teatro, y la
     * revisión es lo único que hace aceptable que pagar sea irreversible.
     */
    async setDraftTotal(id: number, total: Cop): Promise<void> {
      const run = await db
        .selectFrom("commission_run")
        .select(["id", "status"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (run.status !== "borrador") {
        throw new Error(
          `La liquidación ${id} está en estado "${run.status}": su total ya no se recalcula.`,
        );
      }
      await db
        .updateTable("commission_run")
        .set({ total })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Cambia el estado. **Una liquidación pagada no se toca.**
     *
     * El repositorio no valida el *orden* de la transición (borrador →
     * revisada → pagada) ni la compuerta de "no se puede revisar con cuentas
     * sin cerrar en el periodo": eso es lógica de negocio y vive en `lib/`,
     * donde se testea sin base de datos. Acá está solo la regla que protege
     * filas ya escritas.
     */
    async setStatus(
      id: number,
      status: CommissionRunStatus,
      actor: { userId: AuthId; at: Date },
    ): Promise<void> {
      const run = await db
        .selectFrom("commission_run")
        .select(["id", "status"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();

      if (run.status === "pagada") throw new PaidCommissionRunError(id);

      await db
        .updateTable("commission_run")
        .set({
          status,
          ...(status === "revisada"
            ? { reviewed_by: actor.userId, reviewed_at: actor.at }
            : {}),
          ...(status === "pagada"
            ? { paid_by: actor.userId, paid_at: actor.at }
            : {}),
        })
        .where("id", "=", id)
        .execute();
    },
  };
}

export type CommissionRunRepository = ReturnType<typeof commissionRunRepository>;
