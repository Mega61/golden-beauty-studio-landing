import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * `pricing_id` (la vitrina) ↔ `ea_service_id` (lo que se cobra).
 *
 * Con EA en la ecuación hay tres lugares donde vive un precio —
 * `src/data/pricing.ts`, el override de Strapi, y `ea_services.price` — y tres
 * escritores sobre el mismo número es deriva garantizada. La decisión es que
 * `pricing.ts` sigue siendo la fuente de verdad y el panel **publica** en un
 * solo sentido con `PUT /services/{id}`. Esta tabla guarda la
 * correspondencia por id; sin ella la vitrina y el catálogo operativo son dos
 * listas que se separan en silencio.
 *
 * **Las dos columnas son NOT NULL y únicas.** Esta tabla es *el mapeo*, no un
 * inventario de servicios: una fila sin `ea_service_id` no mapea nada. Un
 * servicio "solo vitrina" simplemente no tiene fila acá, y la marca de que eso
 * es deliberado vive en `src/data/pricing.ts` — que es donde
 * `scripts/check-pricing.mjs` la puede leer sin conectarse a la base, que es
 * justamente el punto de que el build falle antes del deploy.
 *
 * Tampoco se guarda la categoría: también vive en `pricing.ts`. Copiarla acá
 * sería un cuarto lugar donde vive un dato que ya tiene dueño.
 *
 * La PK es `pricing_id` y no un autoincremental: la llave natural es el id de
 * la vitrina, y una fila sin `pricing_id` no tiene sentido.
 */
export const migration: Migration = {
  id: "011-service-map",
  description: "Correspondencia pricing.ts ↔ servicios de EA",
  statements: [
    `CREATE TABLE IF NOT EXISTS service_map (
       pricing_id        VARCHAR(64) NOT NULL,
       ea_service_id     INT UNSIGNED NOT NULL,
       last_published_at DATETIME NULL,
       created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (pricing_id),
       -- Uno a uno en los dos sentidos: dos ids de vitrina apuntando al mismo
       -- servicio de EA harían que publicar el precio de uno pisara al otro.
       UNIQUE KEY uq_service_map_ea (ea_service_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
