import type { ServiceMap } from "../types";
import type { Db } from "./shared";

/**
 * El mapeo entre la vitrina y el catálogo operativo.
 *
 * Es la costura que evita que `src/data/pricing.ts` y `ea_services` se separen
 * en silencio. El panel no edita precios: los **publica**, en un solo sentido,
 * y acá queda quién es quién.
 */
export function serviceMapRepository(db: Db) {
  return {
    /** El mapa completo. Es de decenas de filas: se carga entero y se cruza en memoria. */
    async listAll(): Promise<ServiceMap[]> {
      return db.selectFrom("service_map").selectAll().orderBy("pricing_id").execute();
    },

    async findByPricingId(pricingId: string): Promise<ServiceMap | undefined> {
      return db
        .selectFrom("service_map")
        .selectAll()
        .where("pricing_id", "=", pricingId)
        .executeTakeFirst();
    },

    async findByEaServiceId(eaServiceId: number): Promise<ServiceMap | undefined> {
      return db
        .selectFrom("service_map")
        .selectAll()
        .where("ea_service_id", "=", eaServiceId)
        .executeTakeFirst();
    },

    /**
     * Fija (o rehace) la correspondencia de un id de vitrina.
     *
     * El uno-a-uno lo cuida `uq_service_map_ea`: si el `ea_service_id` ya está
     * tomado por otro `pricing_id`, esto falla en vez de dejar dos ids de
     * vitrina apuntando al mismo servicio — que haría que publicar el precio de
     * uno pisara al otro.
     */
    async link(pricingId: string, eaServiceId: number): Promise<void> {
      const existing = await db
        .selectFrom("service_map")
        .select("pricing_id")
        .where("pricing_id", "=", pricingId)
        .executeTakeFirst();

      if (!existing) {
        await db
          .insertInto("service_map")
          .values({ pricing_id: pricingId, ea_service_id: eaServiceId })
          .execute();
        return;
      }
      await db
        .updateTable("service_map")
        .set({ ea_service_id: eaServiceId })
        .where("pricing_id", "=", pricingId)
        .execute();
    },

    /** Después de un `PUT /services/{id}` exitoso. Alimenta la pantalla de diff. */
    async markPublished(pricingId: string, at: Date): Promise<void> {
      await db
        .updateTable("service_map")
        .set({ last_published_at: at })
        .where("pricing_id", "=", pricingId)
        .execute();
    },

    /**
     * Rompe la correspondencia.
     *
     * Borra la fila del mapa, no el servicio de EA. Un servicio que sale de la
     * vitrina puede seguir existiendo en EA con citas históricas colgando, y
     * borrarlo allá sería destruir el pasado para limpiar el presente.
     */
    async unlink(pricingId: string): Promise<void> {
      await db
        .deleteFrom("service_map")
        .where("pricing_id", "=", pricingId)
        .execute();
    },
  };
}

export type ServiceMapRepository = ReturnType<typeof serviceMapRepository>;
