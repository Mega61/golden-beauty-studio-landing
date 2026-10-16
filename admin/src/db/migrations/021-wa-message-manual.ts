import type { Migration } from "./migration";

/**
 * Los recordatorios que manda una persona con `wa.me`, en la misma tabla que
 * los que va a mandar la Cloud API.
 *
 * Agenda Pro manda los recordatorios hoy, y el envío automático por la Cloud
 * API de Meta está trabado en la verificación de negocio y en la aprobación de
 * plantillas. El paliativo que nombra el corte (X7) es un botón que abre
 * `wa.me` con el texto listo: trabajo humano diario, pero nadie se queda sin
 * aviso. Esta migración es lo que ese botón necesita del esquema.
 *
 * ## Por qué en `wa_message` y no en una tabla aparte
 *
 * Por la `UNIQUE (ea_appointment_id, kind)` de la `020`. Si recepción ya le
 * recordó a una clienta a mano, el emisor automático —cuando exista— tiene que
 * ver esa fila y no mandar el mismo aviso otra vez. En una tabla aparte, la
 * llave no cruzaría los dos caminos y la clienta recibiría dos recordatorios
 * el primer día que el cron arranque. La llave es la funcionalidad, no una
 * defensa, y vale igual para los dos canales.
 *
 * ## Las dos columnas
 *
 * - `channel` distingue quién mandó. El valor por defecto es `cloud_api`
 *   porque es lo que la `020` asumía: una fila sin canal explícito es del
 *   emisor automático, y así ningún código escrito contra la `020` cambia de
 *   significado. El camino manual siempre lo escribe.
 * - `sent_by_user_id` es la persona que tocó el botón. Sin llave foránea, como
 *   `audit_log.actor_user_id`: el log no puede quedar huérfano de su fila porque
 *   alguien dio de baja una cuenta del equipo. Vacía en `cloud_api`.
 *
 * ## Idempotente sin `ADD COLUMN IF NOT EXISTS`
 *
 * MySQL 8 no lo tiene (es de MariaDB). Se consulta `information_schema` y se
 * arma la sentencia con `PREPARE`, el mismo patrón de la `016`: una corrida que
 * se cortó a la mitad tiene que poder repetirse entera.
 */
export const migration: Migration = {
  id: "021-wa-message-manual",
  description: "wa_message.channel + sent_by_user_id: recordatorios manuales por wa.me",
  statements: [
    `SET @add_channel := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE wa_message ADD COLUMN channel ENUM(''cloud_api'',''manual'') NOT NULL DEFAULT ''cloud_api'' AFTER kind',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'wa_message'
         AND COLUMN_NAME = 'channel'
     )`,
    `PREPARE stmt_add_channel FROM @add_channel`,
    `EXECUTE stmt_add_channel`,
    `DEALLOCATE PREPARE stmt_add_channel`,

    `SET @add_sent_by := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE wa_message ADD COLUMN sent_by_user_id VARCHAR(36) NULL AFTER channel',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'wa_message'
         AND COLUMN_NAME = 'sent_by_user_id'
     )`,
    `PREPARE stmt_add_sent_by FROM @add_sent_by`,
    `EXECUTE stmt_add_sent_by`,
    `DEALLOCATE PREPARE stmt_add_sent_by`,
  ],
};
