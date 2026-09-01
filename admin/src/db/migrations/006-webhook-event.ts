import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Cada POST recibido de EA.
 *
 * **EA no reintenta.** Es el hueco #5 y el riesgo operativo más probable del
 * proyecto: cada despliegue del panel es una ventana de eventos perdidos. Así
 * que esta tabla no deduplica los reintentos de EA (no existen) sino los
 * **nuestros** — el reconcile nocturno y el reproceso manual — y sirve de
 * rastro para depurar un evento perdido, que acá es el modo de falla esperado y
 * no el raro.
 *
 * ## La llave de deduplicación
 *
 * `(action, ea_entity_id, body_hash)`. Las tres columnas, no dos:
 *
 * - Solo `ea_entity_id` no alcanza: una cita se crea, se reprograma y se
 *   completa, y los tres son eventos distintos sobre la misma entidad.
 * - `action + ea_entity_id` tampoco: dos ediciones distintas de la misma cita
 *   son la misma acción sobre la misma entidad, y las dos hay que procesarlas.
 * - Con el hash del cuerpo, el mismo evento reenviado colapsa y dos cambios
 *   reales no.
 *
 * Un cuerpo malformado deja `ea_entity_id` en `NULL`. MySQL admite varios
 * `NULL` en un índice único, así que esos nunca colapsan entre sí — que es lo
 * correcto: cada cuerpo roto merece su propia fila de rastro.
 *
 * ## Por qué no se guarda el cuerpo
 *
 * Solo el hash. Reprocesar no necesita el cuerpo: el payload de EA es la fila
 * cruda de `ea_appointments` y **no trae precio**, así que reprocesar es volver
 * a pedirle la cita a la API por su id — exactamente lo que hace el reconcile.
 * Guardar el cuerpo metería nombre y teléfono de la clienta en una tabla de log
 * sin política de retención, para no habilitar nada que el id no habilite.
 */
export const migration: Migration = {
  id: "006-webhook-event",
  description: "Rastro y deduplicación de los webhooks recibidos de EA",
  statements: [
    `CREATE TABLE IF NOT EXISTS webhook_event (
       id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       action        VARCHAR(64) NOT NULL,
       ea_entity_id  INT UNSIGNED NULL,
       body_hash     CHAR(64) NOT NULL,
       received_at   DATETIME(3) NOT NULL,
       processed_at  DATETIME(3) NULL,
       error         TEXT NULL,

       PRIMARY KEY (id),
       UNIQUE KEY uq_webhook_event_dedup (action, ea_entity_id, body_hash),
       -- Diagnóstico: "eventos sin procesar" y "último evento recibido".
       KEY idx_webhook_event_pending (processed_at, received_at),
       KEY idx_webhook_event_entity (ea_entity_id, received_at)
     ) ${TABLE_OPTIONS}`,
  ],
};
