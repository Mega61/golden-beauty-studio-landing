import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **Cortesía de la casa**: la clienta no paga, la profesional sí cobra.
 *
 * Las uñas de la dueña, las de su hermana, las de su pareja. Hasta acá se
 * cerraban como una cuenta con el total escrito en `$0` y motivo `cortesia`, y
 * eso tenía un efecto que nadie había decidido: la base de comisión es lo
 * **cobrado** (§ Comisiones), así que la técnica que hizo el trabajo cobraba el
 * 40 % de cero. La dueña confirmó el 2026-10-16 la regla: en una cortesía de la
 * casa la profesional cobra su comisión completa **sobre el precio de lista**, y
 * el estudio recibe cero.
 *
 * ## Una columna y no un cuarto valor del enum de método de pago
 *
 * La alternativa era `appointment_payment.method = 'cortesia'`. Se descartó
 * por tres razones que no son de gusto:
 *
 * 1. **`ck_ap_amount CHECK (amount > 0)`** (`019`). Un pago de cortesía sería
 *    de cero pesos, que es justo lo que ese CHECK existe para rechazar.
 * 2. **El enum es el de Strapi.** `PaymentMethod` espeja `Payment.method` del
 *    CRM (`efectivo | transferencia | otro`) y cada pago cruza hacia allá como
 *    una fila con su `tx_id`. Un cuarto valor tendría que filtrarse en el push,
 *    en los totales del cierre y en cada suma por método — y el día que un
 *    filtro se olvide, Actual Budget recibe un movimiento de `$0` o un enum que
 *    Strapi rechaza con un 400 a mitad del lote del día.
 * 3. **No es un método de pago: es la ausencia de cobro.** Una cortesía no
 *    entra por ninguna parte; modelarla como un pago es mentir en el mismo
 *    lugar donde el resto del esquema se esfuerza por no hacerlo.
 *
 * Con la columna, la cuenta de cortesía **no tiene pagos** (cero filas en
 * `appointment_payment`), y la columna es lo que distingue "no se cobró porque
 * es de la casa" de "no se cobró todavía", que el cierre diario bloquea.
 *
 * ## El CHECK
 *
 * `ck_af_house_courtesy`: una cortesía no cobra y no lleva propina. Es la
 * versión que **sí** se puede expresar en una sola tabla de la regla que
 * importa — que una cortesía nunca produzca ingreso — y por eso está acá y no
 * solo en `lib/ticket.ts`. El ajuste posterior al cierre (`recordAdjustment`)
 * suma un delta a `amount_charged`; sobre una cortesía, la base lo frena.
 *
 * Que la base de comisión sea el precio de lista **no** está en el esquema: cruza
 * a los renglones, y vive en `commissionBasesOf()` de `lib/ticket.ts`.
 *
 * ## `customer_setting`
 *
 * La marca por clienta, "cortesía de la casa por defecto". Las cortesías son
 * siempre las mismas tres o cuatro personas y la hoja de la cuenta la trae
 * marcada sola; sigue siendo editable cuenta por cuenta, porque a veces pagan.
 *
 * Vive en `gbs_admin` y **no** en EA: un campo personalizado de EA viaja a la
 * API pública y a la ficha que ve cualquiera con acceso a la agenda, y "a esta
 * clienta no se le cobra" no es un dato de la agenda. La llave es el
 * `ea_customer_id`, sin llave foránea porque la fila de EA vive en otro esquema
 * que esta conexión no ve. Una persona con varias fichas en EA (ver
 * `clientes/identity.ts`) tiene una fila por ficha: la pantalla las marca juntas.
 *
 * Se apaga poniendo la columna en `0`, no borrando la fila: el set de
 * migraciones no borra, y el repositorio tampoco necesita hacerlo. Quién la
 * cambió y cuándo queda en `audit_log`.
 *
 * Idempotente como todas: la columna y el CHECK se agregan solo si faltan.
 */
export const migration: Migration = {
  id: "026-house-courtesy",
  description:
    "Cortesía de la casa: appointment_finance.is_house_courtesy y customer_setting (cortesía por defecto)",
  statements: [
    `SET @add_courtesy := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_finance ADD COLUMN is_house_courtesy TINYINT(1) NOT NULL DEFAULT 0 AFTER tip',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_finance'
         AND COLUMN_NAME = 'is_house_courtesy'
     )`,
    `PREPARE stmt_add_courtesy FROM @add_courtesy`,
    `EXECUTE stmt_add_courtesy`,
    `DEALLOCATE PREPARE stmt_add_courtesy`,

    `SET @add_courtesy_check := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_finance ADD CONSTRAINT ck_af_house_courtesy CHECK (is_house_courtesy = 0 OR (COALESCE(amount_charged, 0) = 0 AND tip = 0))',
         'SELECT 1'
       )
       FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_finance'
         AND CONSTRAINT_NAME = 'ck_af_house_courtesy'
     )`,
    `PREPARE stmt_add_courtesy_check FROM @add_courtesy_check`,
    `EXECUTE stmt_add_courtesy_check`,
    `DEALLOCATE PREPARE stmt_add_courtesy_check`,

    `CREATE TABLE IF NOT EXISTS customer_setting (
       ea_customer_id          INT UNSIGNED NOT NULL,
       house_courtesy_default  TINYINT(1) NOT NULL DEFAULT 0,
       updated_by              VARCHAR(36) NULL,
       updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (ea_customer_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
