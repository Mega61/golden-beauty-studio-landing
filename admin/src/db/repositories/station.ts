import type { Station } from "../types";
import type { Db } from "./shared";

/**
 * Los puestos físicos del estudio.
 *
 * Es la tabla más pequeña del esquema y la que evita el peor error posible:
 * vender por la web una hora en la que no hay silla. EA no tiene ningún
 * concepto de sala, puesto o equipo, así que la capacidad del local no existe
 * en ningún lado salvo acá.
 *
 * Solo lectura, y a propósito: dos filas sembradas por la migración `012`, y
 * cambiarlas es un cambio de infraestructura del estudio — un puesto nuevo —
 * que merece pasar por una migración y no por un formulario. `allows` en `null`
 * significa "cualquier categoría"; queda pendiente confirmar si las dos
 * estaciones son intercambiables o si una es de manos y otra de pies.
 */
export function stationRepository(db: Db) {
  return {
    async listAll(): Promise<Station[]> {
      return db.selectFrom("station").selectAll().orderBy("id").execute();
    },

    /** Cuántas sillas hay. Es el denominador de la ocupación por estación. */
    async count(): Promise<number> {
      const rows = await db.selectFrom("station").select("id").execute();
      return rows.length;
    },
  };
}

export type StationRepository = ReturnType<typeof stationRepository>;
