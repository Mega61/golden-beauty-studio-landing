import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **Tarjetas regalo** ("bonos"): venderlas y redimirlas.
 *
 * La tarjeta vive en Stampee (`gift_cards`): código `TR-XXXX-XXXX`, monto,
 * estado, a quién va. La plata vive acá, porque es el panel quien la manda a
 * Actual. Dos momentos, dos lugares:
 *
 * 1. **La venta** (`gift_card_sale`). La compradora paga por transferencia o
 *    en efectivo y alguien la confirma desde `/caja/regalos`. Esa plata es
 *    ingreso del día en que entró: la sincronización nocturna la manda al CRM
 *    como `bono:<código>`, sin depender de ningún cierre del día. Una venta
 *    anulada **después** de haber viajado sale como `bono:<código>:adj1` en
 *    negativo, porque Actual no cambia un monto ya importado.
 * 2. **La redención**, al cerrar la cuenta en Hoy. Una tarjeta pagada
 *    (`funded`) es un **pago** con método `bono`: la plata ya entró el día de
 *    la venta, así que ese pago **no** viaja otra vez. Una tarjeta
 *    promocional (sin plata detrás, la del calendario de adviento) es un
 *    **descuento**: se guarda como cualquier promo, con motivo `promo` y el
 *    código en `variance_reason`.
 *
 * - `appointment_payment.method` acepta `bono` (al final del ENUM: cambio de
 *   metadatos, ningún valor existente cambia de índice) y gana
 *   `gift_card_code`, el código de la tarjeta que pagó.
 * - `appointment_finance.gift_card_code`: la tarjeta redimida en esta cuenta,
 *   pagada o promocional. Es lo que permite deshacer la redención en Stampee
 *   cuando alguien corrige la cuenta y la quita.
 * - `appointment_finance.tip_method`: con qué se dejó la propina **cuando la
 *   tarjeta pagó toda la cuenta**. La propina es plata de verdad que entra al
 *   cajón o al banco y viaja a Actual (un movimiento de monto 0 + propina);
 *   sin ningún otro pago no habría de dónde sacar el método, y un pago de
 *   cero no cabe en `appointment_payment` (`ck_ap_amount`). Con otro pago la
 *   propina va en él, como siempre, y esto queda en `NULL`.
 *
 * Sin FK hacia Stampee (otro servicio). Idempotente como el resto del set:
 * cada `ALTER` corre solo si la columna todavía no está.
 */
export const migration: Migration = {
  id: "033-gift-cards",
  description:
    "Tarjetas regalo: gift_card_sale, el método de pago 'bono' y el código de la tarjeta en la cuenta",
  statements: [
    `CREATE TABLE IF NOT EXISTS gift_card_sale (
       id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       stampee_gift_card_id  VARCHAR(64)  NOT NULL,
       code                  VARCHAR(20)  NOT NULL,
       tier_name             VARCHAR(120) NULL,
       amount                INT          NOT NULL,
       method                ENUM('efectivo','transferencia','otro') NOT NULL,
       paid_at               DATETIME     NOT NULL,
       paid_ref              VARCHAR(120) NULL,
       buyer_name            VARCHAR(200) NULL,
       buyer_phone           VARCHAR(30)  NULL,
       created_by            VARCHAR(36)  NULL,
       created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       voided_at             DATETIME     NULL,
       voided_by             VARCHAR(36)  NULL,
       void_reason           VARCHAR(500) NULL,
       pushed_to_ingest_at   DATETIME     NULL,
       void_pushed_at        DATETIME     NULL,

       PRIMARY KEY (id),
       -- Una tarjeta se vende una vez: confirmar el pago dos veces (dos
       -- pestañas, un reintento) no puede crear dos ingresos.
       UNIQUE KEY uq_gcs_card (stampee_gift_card_id),
       UNIQUE KEY uq_gcs_code (code),
       KEY idx_gcs_paid_at (paid_at),
       KEY idx_gcs_pushed (pushed_to_ingest_at),

       CONSTRAINT ck_gcs_amount CHECK (amount > 0)
     ) ${TABLE_OPTIONS}`,

    `SET @add_bono_method := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_payment MODIFY COLUMN method ENUM(''efectivo'',''transferencia'',''otro'',''bono'') NOT NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_payment'
         AND COLUMN_NAME = 'method'
         AND COLUMN_TYPE LIKE '%''bono''%'
     )`,
    `PREPARE stmt_add_bono_method FROM @add_bono_method`,
    `EXECUTE stmt_add_bono_method`,
    `DEALLOCATE PREPARE stmt_add_bono_method`,

    `SET @add_payment_gift_code := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_payment ADD COLUMN gift_card_code VARCHAR(20) NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_payment'
         AND COLUMN_NAME = 'gift_card_code'
     )`,
    `PREPARE stmt_add_payment_gift_code FROM @add_payment_gift_code`,
    `EXECUTE stmt_add_payment_gift_code`,
    `DEALLOCATE PREPARE stmt_add_payment_gift_code`,

    `SET @add_finance_gift_code := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_finance ADD COLUMN gift_card_code VARCHAR(20) NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_finance'
         AND COLUMN_NAME = 'gift_card_code'
     )`,
    `PREPARE stmt_add_finance_gift_code FROM @add_finance_gift_code`,
    `EXECUTE stmt_add_finance_gift_code`,
    `DEALLOCATE PREPARE stmt_add_finance_gift_code`,

    `SET @add_finance_tip_method := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_finance ADD COLUMN tip_method ENUM(''efectivo'',''transferencia'',''otro'') NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_finance'
         AND COLUMN_NAME = 'tip_method'
     )`,
    `PREPARE stmt_add_finance_tip_method FROM @add_finance_tip_method`,
    `EXECUTE stmt_add_finance_tip_method`,
    `DEALLOCATE PREPARE stmt_add_finance_tip_method`,
  ],
};
