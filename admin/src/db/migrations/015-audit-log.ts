import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Quién cambió qué desde el panel.
 *
 * Existe por una razón concreta: **la técnica pone el número**. Esa es la
 * decisión que hace usable el sistema y también la que abre la puerta a errores
 * y a fuga, y las tres defensas son de diseño y no de confianza — precio de
 * lista siempre visible al lado del cobrado, motivo obligatorio cuando
 * difieren, y esta tabla. La cuenta se puede corregir; lo que no se puede es
 * corregirla sin dejar huella.
 *
 * **Sin llaves foráneas, a propósito.** Es un log append-only. Una FK hacia
 * `user` podría bloquear un borrado legítimo o, peor con un CASCADE, borrar el
 * rastro de lo que esa persona hizo justo cuando más se necesita. Por la misma
 * razón `entity_id` es `VARCHAR` y no un id tipado: apunta a filas de tablas
 * distintas, y a veces a ids de EA que no viven en este esquema.
 *
 * `actor_user_id` en `NULL` significa "el sistema" — el handler del webhook, el
 * reconcile nocturno, el cron de cierre. Es un valor legítimo, no un dato
 * faltante.
 *
 * `before_json` / `after_json` guardan el antes y el después. `JSON` y no
 * `TEXT` para que una consulta pueda entrar al documento sin parsearlo en la
 * app el día que Diagnóstico necesite "todas las correcciones de total del mes".
 */
export const migration: Migration = {
  id: "015-audit-log",
  description: "Bitácora append-only de escrituras del panel",
  statements: [
    `CREATE TABLE IF NOT EXISTS audit_log (
       id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       actor_user_id VARCHAR(36) NULL,
       action        VARCHAR(64) NOT NULL,
       entity        VARCHAR(64) NOT NULL,
       entity_id     VARCHAR(64) NOT NULL,
       before_json   JSON NULL,
       after_json    JSON NULL,
       reason        VARCHAR(500) NULL,
       created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

       PRIMARY KEY (id),
       -- "Qué le pasó a esta cuenta" — el uso diario, desde el detalle de la cita.
       KEY idx_audit_entity (entity, entity_id, created_at),
       -- "Qué hizo esta persona en el periodo" — la revisión de la quincena.
       KEY idx_audit_actor (actor_user_id, created_at),
       KEY idx_audit_created (created_at)
     ) ${TABLE_OPTIONS}`,
  ],
};
