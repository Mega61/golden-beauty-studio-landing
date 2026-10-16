import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los celulares que piden aviso cuando alguien reserva desde la página.
 *
 * La página pública ya toma reservas (y con pauta paga detrás), y hasta ahora
 * nadie se enteraba: la cita aparecía en la agenda y la veía quien la abriera.
 * Cada fila es **un navegador en un dispositivo** suscrito a Web Push, no una
 * persona: la dueña puede tener el aviso en el celular y no en el computador
 * del estudio, y el toggle de Ajustes es por dispositivo por eso mismo.
 *
 * ## `endpoint` en ASCII y binario, y por qué cabe en un UNIQUE
 *
 * El `endpoint` es una URL que emite el servicio de push del navegador (FCM,
 * Apple, Mozilla) y es la identidad de la suscripción: el mismo celular que se
 * vuelve a suscribir trae el mismo endpoint, y la llave única es lo que hace
 * que eso actualice la fila en vez de duplicar el aviso.
 *
 * Una URL es ASCII, así que la columna va en `ascii`: 1 byte por carácter. En
 * `utf8mb4` un `VARCHAR(2048)` reserva 8 KB y no cabe en el límite de 3072
 * bytes de una llave de InnoDB; en `ascii` sí. `ascii_bin` porque el endpoint
 * distingue mayúsculas — dos tokens que solo difieren en una letra son dos
 * celulares distintos, y una colación `_ci` los fundiría en uno.
 *
 * ## Lo que se guarda y lo que no
 *
 * - `p256dh` y `auth` son las llaves públicas del navegador con las que se
 *   cifra el contenido. Sin ellas no se puede mandar nada. No son secretos del
 *   panel, pero el endpoint sí es una capacidad: quien lo tiene puede
 *   mandarle avisos a ese celular (si además tiene la llave VAPID privada).
 *   Por eso nunca va a la bitácora ni a un log.
 * - `user_agent` es solo para que la pantalla diga "este iPhone" o "Chrome en
 *   Android" y la persona reconozca cuál es cuál. Recortado a 300.
 * - `last_success_at` y `failure_count` deciden la poda. Un 404/410 del
 *   servicio de push borra la fila en el acto (la suscripción ya no existe);
 *   los demás errores suman, y una fila que acumula fallas seguidas sin un
 *   solo éxito se poda también. Las reglas viven en `lib/push/prune.ts`.
 *
 * ## FK con CASCADE hacia `user`
 *
 * Si la cuenta deja de existir, sus celulares dejan de recibir avisos con
 * nombres de clientas. Es el mismo razonamiento que `staff_totp`. Quitar a
 * alguien de `allowed_user` sin borrar su cuenta **no** borra la fila, pero el
 * envío vuelve a preguntar el rol en cada aviso y la salta.
 */
export const migration: Migration = {
  id: "022-push-subscription",
  description: "Suscripciones Web Push: avisos de reservas hechas en la página",
  statements: [
    `CREATE TABLE IF NOT EXISTS push_subscription (
       id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       user_id          VARCHAR(36) NOT NULL,
       endpoint         VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       p256dh           VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       auth             VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       user_agent       VARCHAR(300) NULL,

       last_success_at  DATETIME NULL,
       -- Fallas seguidas desde el último éxito. Vuelve a 0 con cada aviso que
       -- el servicio de push acepta.
       failure_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
       last_failure_at  DATETIME NULL,

       created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- Un celular, una fila. Volver a suscribirse actualiza, no duplica.
       UNIQUE KEY uq_push_endpoint (endpoint),
       -- "Mis dispositivos", que es lo que lista Ajustes.
       KEY idx_push_user (user_id),

       CONSTRAINT fk_push_user FOREIGN KEY (user_id)
         REFERENCES \`user\` (id) ON DELETE CASCADE ON UPDATE CASCADE
     ) ${TABLE_OPTIONS}`,
  ],
};
