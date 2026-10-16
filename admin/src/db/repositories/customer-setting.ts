import type { AuthId } from "../types";
import type { Db } from "./shared";

/**
 * `customer_setting`: lo que el panel sabe de una ficha de clienta y EA no
 * (migración `026`). Hoy, una sola cosa: si es **cortesía de la casa por
 * defecto**.
 *
 * Lee y escribe filas, nada más. Que la marca solo la cambie la dueña lo decide
 * la Server Action (`cortesia:otorgar`); que la marca solo **pre-marque** la
 * hoja de la cuenta —y no decida nada sola— lo decide la hoja.
 */
export function customerSettingRepository(db: Db) {
  return {
    /**
     * De un conjunto de fichas, cuáles son cortesía por defecto.
     *
     * Una sola consulta para todas: la pantalla Hoy la pide para el día entero.
     * Una ficha sin fila no es cortesía — el valor por defecto es cobrar.
     */
    async listHouseCourtesyIds(eaCustomerIds: readonly number[]): Promise<Set<number>> {
      if (eaCustomerIds.length === 0) return new Set();
      const rows = await db
        .selectFrom("customer_setting")
        .select("ea_customer_id")
        .where("ea_customer_id", "in", [...new Set(eaCustomerIds)])
        .where("house_courtesy_default", "=", 1)
        .execute();
      return new Set(rows.map((row) => row.ea_customer_id));
    },

    /**
     * Prende o apaga la marca en varias fichas a la vez.
     *
     * Varias porque una persona puede tener más de una ficha en EA con el mismo
     * teléfono (`clientes/identity.ts`): marcar solo una dejaría a la otra
     * cobrando la próxima vez que reserve por esa. Apagar es poner `0`, no
     * borrar la fila; quién lo hizo queda en la bitácora, que es quien llama.
     */
    async setHouseCourtesy(
      eaCustomerIds: readonly number[],
      enabled: boolean,
      updatedBy: AuthId | null,
    ): Promise<void> {
      for (const eaCustomerId of new Set(eaCustomerIds)) {
        await db
          .insertInto("customer_setting")
          .values({
            ea_customer_id: eaCustomerId,
            house_courtesy_default: enabled ? 1 : 0,
            updated_by: updatedBy,
          })
          .onDuplicateKeyUpdate({
            house_courtesy_default: enabled ? 1 : 0,
            updated_by: updatedBy,
          })
          .execute();
      }
    },
  };
}

export type CustomerSettingRepository = ReturnType<typeof customerSettingRepository>;
