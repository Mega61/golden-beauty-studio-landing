import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Un combo es **un servicio de EA**, no dos citas enlazadas.
 *
 * Publicar un combo escribe un servicio en la categoría "Combos" de EA más esta
 * fila, que registra la composición. Así la disponibilidad de EA, el flujo de
 * reserva y el calendario funcionan de forma nativa, y los reportes pueden
 * seguir atribuyendo ingreso a los servicios de manos y pies subyacentes.
 *
 * **Precio y duración son criterio de la dueña, no fórmula.** Los datos reales
 * lo muestran: un combo cuesta y dura *menos* que la suma de sus partes, y
 * cuánto menos no sale de ninguna regla. El constructor muestra la suma como
 * referencia y exige los dos números explícitos. Nunca se auto-calculan.
 *
 * `allocation_hands_bp` es el reparto de comisión cuando dos técnicas trabajan
 * el mismo combo (una las manos, otra los pies). En puntos básicos por la misma
 * razón que las tasas de `commission_rule`: 6667 es dos tercios exactos hasta
 * donde importa, y `66` no. El residuo del reparto lo asigna
 * `lib/combo-allocation.ts` de forma determinista, y las partes suman exacto al
 * precio del combo.
 */
export const migration: Migration = {
  id: "010-combo",
  description: "Composición de los combos y su reparto de comisión",
  statements: [
    `CREATE TABLE IF NOT EXISTS combo (
       id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_service_id        INT UNSIGNED NOT NULL,
       hands_ea_service_id  INT UNSIGNED NOT NULL,
       feet_ea_service_id   INT UNSIGNED NOT NULL,
       price                INT UNSIGNED NOT NULL,
       duration_min         SMALLINT UNSIGNED NOT NULL,
       allocation_hands_bp  SMALLINT UNSIGNED NOT NULL,
       created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- Un servicio de EA es a lo sumo un combo. Si hubiera dos filas para el
       -- mismo servicio, el reporte atribuiría el ingreso dos veces.
       UNIQUE KEY uq_combo_ea_service (ea_service_id),
       KEY idx_combo_parts (hands_ea_service_id, feet_ea_service_id),

       CONSTRAINT ck_combo_allocation CHECK (allocation_hands_bp <= 10000),
       CONSTRAINT ck_combo_duration CHECK (duration_min > 0)
     ) ${TABLE_OPTIONS}`,
  ],
};
