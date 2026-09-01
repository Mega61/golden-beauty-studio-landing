import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los renglones de la cuenta.
 *
 * Es lo que permite que la técnica registre adicionales y un servicio distinto
 * al agendado. Una cita deja de tener *un* precio y pasa a tener una cuenta.
 *
 * **Precio congelado por renglón**, no solo el total: el servicio agendado ya
 * tenía su snapshot desde el webhook, y el realizado más los adicionales se
 * congelan al cerrar la cuenta — mismo día, así que no hay deriva posible. La
 * comisión se calcula sobre el renglón realizado, y recalcularla con el precio
 * de lista de hoy sobre una cita vieja está mal.
 *
 * `qty` y `line_total` van **con signo**. Dos casos reales lo exigen: el
 * retoque de garantía es un renglón `manual` en cero con su nota (queda contado
 * en ocupación y en la ficha de la clienta sin cobrar), y una corrección
 * posterior al cierre entra como renglón nuevo, que puede ser negativo, nunca
 * como edición en sitio.
 *
 * El `ON DELETE CASCADE` hacia el encabezado es el único CASCADE de plata del
 * esquema, y es correcto: los renglones no existen sin su cuenta. Lo que no
 * cascadea es la comisión ya calculada sobre un renglón — ver `009`.
 */
export const migration: Migration = {
  id: "005-appointment-finance-item",
  description: "Renglones de la cuenta: servicio, adicionales y manuales",
  statements: [
    `CREATE TABLE IF NOT EXISTS appointment_finance_item (
       id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       appointment_finance_id BIGINT UNSIGNED NOT NULL,
       kind                   ENUM('servicio','adicional','manual') NOT NULL,
       ea_service_id          INT UNSIGNED NULL,
       pricing_id             VARCHAR(64) NULL,
       qty                    SMALLINT NOT NULL DEFAULT 1,
       unit_price_snapshot    INT NOT NULL,
       line_total             INT NOT NULL,
       note                   VARCHAR(500) NULL,
       created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- El orden de los renglones dentro de una cuenta es el orden de \`id\`.
       -- Importa: el prorrateo del descuento asigna el peso de residuo de forma
       -- determinista, y "determinista" necesita un orden estable.
       KEY idx_afi_finance (appointment_finance_id, id),
       -- Reportes por servicio realizado y "adicionales: enganche y monto".
       KEY idx_afi_service (ea_service_id),
       KEY idx_afi_pricing (pricing_id),

       CONSTRAINT fk_afi_finance FOREIGN KEY (appointment_finance_id)
         REFERENCES appointment_finance (id) ON DELETE CASCADE ON UPDATE CASCADE,

       -- Un renglón \`manual\` es "lo que no está en el catálogo" y exige nota;
       -- sin ella, en el reporte de variación aparece un monto sin explicación.
       CONSTRAINT ck_afi_manual_needs_note CHECK (
         kind <> 'manual' OR note IS NOT NULL
       )
     ) ${TABLE_OPTIONS}`,
  ],
};
