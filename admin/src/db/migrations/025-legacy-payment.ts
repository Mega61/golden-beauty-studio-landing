import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los pagos del historial de Agenda Pro: cómo se pagó cada venta.
 *
 * `legacy_appointment` (la `014`) sale del reporte de **reservas**, que trae lo
 * cobrado pero no **cómo**. La dueña quiere ver efectivo contra transferencia y
 * las propinas del tiempo de Agenda Pro, y eso solo viene en los reportes de
 * plata de Agenda Pro —ventas y transacciones—, que tienen otra forma y otros
 * ids. Por eso es una tabla aparte y no tres columnas más en la `014`: una
 * venta puede tener varios pagos (pago dividido) y un pago puede no casar con
 * ninguna reserva, y forzar las dos cosas a la misma fila sería inventar.
 *
 * ## Por qué cada columna es como es
 *
 * - `(source_tx_id, part)` UNIQUE: el "ID" de la transacción en Agenda Pro y
 *   la parte. Los reportes de plata se bajan por tramos de un mes y los tramos
 *   se pisan, así que el mismo pago llega en dos archivos; esta llave hace que
 *   importarlo dos veces no duplique nada. `part` es `0` para casi todo: solo
 *   un pago que en la realidad se hizo con dos medios (la venta 1119: $150.000
 *   en efectivo + $10.000 por transferencia, que Agenda Pro guardó como un solo
 *   pago) se parte en `0` y `1`. Filas hermanas con la misma llave de origen,
 *   y no una tabla de hijos, porque así cada fila es un monto con **un** medio
 *   y todo reporte suma sin tener que saber que existen las partes; la suma de
 *   las partes es exactamente el monto de la transacción (el importador lo
 *   exige).
 * - `amount` y `tip` en **pesos enteros**, separados: la propina es de la
 *   técnica y nunca entra a ventas ni a ticket promedio (la misma regla que
 *   `appointment_finance.tip`).
 * - `method` es el medio **real**, el que leen todos los reportes, y
 *   `method_agendapro` el que dijo Agenda Pro. Casi siempre son el mismo; la
 *   dueña a veces marcó en Agenda Pro "Transferencia" una venta en efectivo (y
 *   una vez al revés) y la corrigió a mano en Actual Budget. El importador
 *   aplica esas correcciones desde un archivo aparte y guarda las dos cosas,
 *   para que la diferencia se pueda auditar. `method_raw` es el texto tal cual
 *   ("Transferencia Bancaria").
 * - `is_courtesy`: ventas de cortesía (la dueña, su hermana, Juan). No entró
 *   plata, pero **sí** es trabajo de la técnica y su comisión se calculó sobre
 *   ellas — por eso la fila existe con su monto nominal. Los reportes la sacan
 *   de ventas, del reparto por medio y del ticket promedio, y la muestran
 *   aparte; las visitas la siguen contando.
 * - `client_name`, `service_name`, `provider_name` y `booked_at` salen de la
 *   hoja "Ítems" del reporte de ventas y existen para **casar** el pago con su
 *   reserva. Por nombre, como en la `014`: Agenda Pro no comparte ids con EA.
 * - `legacy_appointment_id` **sin llave foránea**: el enlace lo decide el
 *   importador por fecha de reserva y nombre, y puede quedar `NULL` (pago sin
 *   reserva que case). Con FK, reimportar el historial de reservas obligaría a
 *   borrar pagos primero; sin ella, el próximo `--aplicar` completa los
 *   enlaces que falten.
 *
 * ## ⚠ Lectura para pantalla, nunca plata que sale del panel
 *
 * Esa plata ya está en Actual Budget, metida por el scraper de Agenda Pro con
 * `imported_id = agendapro-tx:<id>`. Esta tabla no la leen `appointment_finance`,
 * la caja / cierre del día, el ingest a Strapi/Actual, las comisiones ni los
 * recordatorios; `lib/legacy-history.money-paths.test.ts` lo vigila.
 */
export const migration: Migration = {
  id: "025-legacy-payment",
  description: "Pagos del historial de Agenda Pro: medio real y de Agenda Pro, propina, cortesía y enlace a la reserva",
  statements: [
    `CREATE TABLE IF NOT EXISTS legacy_payment (
       id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       source_tx_id           VARCHAR(32) NOT NULL,
       part                   TINYINT UNSIGNED NOT NULL DEFAULT 0,
       sale_id                VARCHAR(32) NULL,
       paid_at                DATETIME NOT NULL,
       amount                 INT NOT NULL,
       tip                    INT NOT NULL DEFAULT 0,
       method                 ENUM('efectivo','transferencia','otro') NOT NULL,
       method_agendapro       ENUM('efectivo','transferencia','otro') NOT NULL,
       method_raw             VARCHAR(80) NULL,
       is_courtesy            TINYINT(1) NOT NULL DEFAULT 0,
       client_name            VARCHAR(160) NULL,
       service_name           VARCHAR(255) NULL,
       provider_name          VARCHAR(120) NULL,
       booked_at              DATETIME NULL,
       legacy_appointment_id  BIGINT UNSIGNED NULL,
       imported_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       UNIQUE KEY uq_legacy_payment_tx (source_tx_id, part),
       KEY idx_legacy_payment_paid (paid_at),
       -- La ficha de la clienta pregunta "¿cómo pagó esta cita?" por el enlace.
       KEY idx_legacy_payment_appointment (legacy_appointment_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
