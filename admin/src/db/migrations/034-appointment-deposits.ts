import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **Adelantos** ("abonos"): plata que la clienta paga antes de su cita.
 *
 * En temporada (diciembre) el estudio pide un adelanto para separar el cupo.
 * Hasta acá el panel no tenía dónde ponerlo: una cuenta se cobraba entera el
 * día de la cita, así que la transferencia de noviembre quedaba suelta en el
 * banco sin una venta en Actual con la cual enlazarse, y la de diciembre no
 * cuadraba con el total.
 *
 * Mismo molde que las tarjetas regalo (`033`), dos momentos:
 *
 * 1. **El adelanto** (`appointment_deposit`). Es ingreso **del día en que
 *    entró**: la sincronización de la noche lo manda al CRM como
 *    `abono:<id>`, y en Actual aparece ese mismo día con la plata que llegó al
 *    banco o al cajón. Una devolución (o una anulación de algo mal escrito)
 *    después de haber viajado sale como `abono:<id>:adj1` en negativo.
 * 2. **El cobro de la cita**. El adelanto es un **pago** con método `abono`
 *    que no viaja otra vez; los métodos de la hoja pagan el resto, que viaja
 *    como siempre (`ea-appt:<id>`).
 *
 * - Va pegado a la cita de EA (`ea_appointment_id`), sin FK: la fila de plata
 *   de la cita (`appointment_finance`) puede no existir todavía cuando la
 *   clienta paga semanas antes.
 * - `appointment_start_at` es una copia de la hora de la cita (pared de EA)
 *   para la lista de Caja y las notas de Actual, sin preguntarle a EA, que
 *   corta a 100 peticiones cada 120 s. Se reescribe al pasar el adelanto de
 *   cita; si la cita se mueve en la agenda queda vieja, y es solo un rótulo.
 * - Una cita puede tener más de un adelanto (pagó en dos partes). Al cobrar
 *   se suman en un solo pago `abono`.
 * - La devolución es una sola por adelanto, parcial o total
 *   (`refunded_amount`), con su propio método y su propio día de caja.
 *
 * `appointment_payment.method` gana `abono` al final del ENUM: cambio de
 * metadatos, ningún valor existente cambia de índice.
 */
export const migration: Migration = {
  id: "034-appointment-deposits",
  description: "Adelantos: appointment_deposit y el método de pago 'abono'",
  statements: [
    `CREATE TABLE IF NOT EXISTS appointment_deposit (
       id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_appointment_id     INT UNSIGNED NOT NULL,
       appointment_start_at  DATETIME     NULL,
       amount                INT          NOT NULL,
       method                ENUM('efectivo','transferencia','otro') NOT NULL,
       paid_at               DATETIME     NOT NULL,
       paid_ref              VARCHAR(120) NULL,
       customer_name         VARCHAR(200) NULL,
       customer_phone        VARCHAR(30)  NULL,
       created_by            VARCHAR(36)  NULL,
       created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       refunded_amount       INT          NULL,
       refund_method         ENUM('efectivo','transferencia','otro') NULL,
       refunded_at           DATETIME     NULL,
       refunded_by           VARCHAR(36)  NULL,
       refund_reason         VARCHAR(500) NULL,
       pushed_to_ingest_at   DATETIME     NULL,
       refund_pushed_at      DATETIME     NULL,

       PRIMARY KEY (id),
       KEY idx_ad_appointment (ea_appointment_id),
       KEY idx_ad_paid_at (paid_at),
       KEY idx_ad_refunded_at (refunded_at),
       KEY idx_ad_phone (customer_phone),

       CONSTRAINT ck_ad_amount CHECK (amount > 0),
       CONSTRAINT ck_ad_refund CHECK (
         (refunded_amount IS NULL AND refund_method IS NULL AND refunded_at IS NULL)
         OR (refunded_amount > 0 AND refunded_amount <= amount
             AND refund_method IS NOT NULL AND refunded_at IS NOT NULL)
       )
     ) ${TABLE_OPTIONS}`,

    `SET @add_abono_method := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_payment MODIFY COLUMN method ENUM(''efectivo'',''transferencia'',''otro'',''bono'',''abono'') NOT NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_payment'
         AND COLUMN_NAME = 'method'
         AND COLUMN_TYPE LIKE '%''abono''%'
     )`,
    `PREPARE stmt_add_abono_method FROM @add_abono_method`,
    `EXECUTE stmt_add_abono_method`,
    `DEALLOCATE PREPARE stmt_add_abono_method`,
  ],
};
