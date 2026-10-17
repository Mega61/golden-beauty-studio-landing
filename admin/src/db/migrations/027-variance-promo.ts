import type { Migration } from "./migration";

/**
 * **El motivo `promo`** en `appointment_finance.variance_reason_code`.
 *
 * Desde el 2026-10-16 la cuenta aplica sola las promos de la dueña al cerrarse
 * —miércoles de pies, sábado de press-on, 10 % en la primera visita—
 * (`lib/promos.ts`, resuelto en `components/ticket/draft.ts`). Ese descuento
 * es una variación contra el precio de lista como cualquier otra, y la
 * compuerta de `validateTicketClose()` exige un motivo para toda variación. Sin
 * un código propio había dos salidas malas:
 *
 * - **Pedirle el motivo a la técnica** en cada cuenta de miércoles: un toque de
 *   más entre dos clientas para decir algo que el sistema ya sabe.
 * - **Disfrazarla de `otro` o `cortesia`**: el reporte de variación por motivo
 *   ("dónde se escapa la plata") mezclaría la promo pactada con la rebaja que
 *   alguien decidió en la silla, y son preguntas distintas.
 *
 * El código lo pone **solo el servidor**, cuando el descuento guardado es
 * exactamente el que `bestPromo()` calculó con el catálogo del servidor; el
 * navegador no lo puede mandar (el `z.enum` de `hoy/actions.ts` no lo trae). En
 * `variance_reason` va cuál promo fue (`miercoles-pies`, `primera-visita`…).
 *
 * ## Por qué un `MODIFY` y no una columna
 *
 * Agregar un valor **al final** de un `ENUM` es un cambio de metadatos en MySQL
 * 8 (no reescribe la tabla) y no le cambia el índice a ningún valor existente,
 * así que ninguna fila cambia de significado. Es la misma columna y la misma
 * pregunta: por qué se cobró distinto de la lista.
 *
 * Idempotente como las demás: solo corre si el tipo de la columna todavía no
 * nombra `promo`. Forward-only: no hay vuelta atrás que quite el valor, y una
 * imagen anterior que lea una fila con `promo` la ve como un código que no
 * conoce, no la rompe.
 */
export const migration: Migration = {
  id: "027-variance-promo",
  description:
    "appointment_finance.variance_reason_code acepta 'promo' (promos aplicadas al cerrar la cuenta)",
  statements: [
    `SET @add_promo_reason := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE appointment_finance MODIFY COLUMN variance_reason_code ENUM(''cambio_servicio'',''adicionales'',''cortesia'',''correccion'',''otro'',''promo'') NULL',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment_finance'
         AND COLUMN_NAME = 'variance_reason_code'
         AND COLUMN_TYPE LIKE '%''promo''%'
     )`,
    `PREPARE stmt_add_promo_reason FROM @add_promo_reason`,
    `EXECUTE stmt_add_promo_reason`,
    `DEALLOCATE PREPARE stmt_add_promo_reason`,
  ],
};
