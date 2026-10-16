import type { AdChannel, AdSpendRow, AuthId, Cop } from "../types";
import type { Db } from "./shared";

/**
 * `ad_spend`: la inversión en anuncios por mes y canal (migración `023`).
 *
 * Lee y escribe filas, nada más. Qué meses tocan un periodo y cómo se reparte
 * la cifra entre las clientas nuevas lo decide `reportes/acquisition.ts`, que
 * es puro y está testeado.
 */

export type AdSpendInput = {
  month: string;
  channel: AdChannel;
  amountCop: Cop;
  notes: string | null;
  updatedBy: AuthId | null;
};

export function adSpendRepository(db: Db) {
  return {
    /** Las filas de unos meses `"YYYY-MM"`, todos los canales. */
    async listByMonths(months: readonly string[]): Promise<AdSpendRow[]> {
      if (months.length === 0) return [];
      return db
        .selectFrom("ad_spend")
        .selectAll()
        .where("month", "in", [...months])
        .orderBy("month")
        .orderBy("channel")
        .execute();
    },

    async find(month: string, channel: AdChannel): Promise<AdSpendRow | undefined> {
      return db
        .selectFrom("ad_spend")
        .selectAll()
        .where("month", "=", month)
        .where("channel", "=", channel)
        .executeTakeFirst();
    },

    /**
     * Alta o reemplazo por `(month, channel)`.
     *
     * **Reemplaza, no suma.** Quien vuelve a guardar marzo está corrigiendo un
     * número, no agregando una segunda factura; sumar duplicaría la inversión
     * en silencio y abarataría el costo por clienta a la mitad. Lo que había
     * antes lo guarda la bitácora, que es quien llama.
     */
    async upsert(input: AdSpendInput): Promise<void> {
      await db
        .insertInto("ad_spend")
        .values({
          month: input.month,
          channel: input.channel,
          amount_cop: input.amountCop,
          notes: input.notes,
          updated_by: input.updatedBy,
        })
        .onDuplicateKeyUpdate({
          amount_cop: input.amountCop,
          notes: input.notes,
          updated_by: input.updatedBy,
        })
        .execute();
    },
  };
}

export type AdSpendRepository = ReturnType<typeof adSpendRepository>;
