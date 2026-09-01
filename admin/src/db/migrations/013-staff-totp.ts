import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * El segundo camino de login, para las técnicas.
 *
 * Usan correo personal, así que la compuerta de Workspace las deja afuera por
 * diseño. Su entrada es un código TOTP de seis dígitos desde la app de
 * autenticación de su celular: sin contraseña, sin correo corporativo, sin una
 * silla de licencia por persona.
 *
 * `user_id` es la PK: una técnica, un secreto. No hay historial de secretos
 * viejos — recuperar es re-enrolarse, y un secreto revocado que sigue en la
 * base es un secreto que alguien puede volver a habilitar por error.
 *
 * `secret_encrypted` es `VARBINARY` porque va cifrado con `TOTP_ENC_KEY` y
 * **nunca en claro**. El tipo binario también evita el accidente clásico de que
 * una colación `_ci` haga comparaciones sin distinguir mayúsculas sobre algo
 * que no es texto.
 *
 * `last_used_step` es la anti-repetición, y es obligatoria: un código vive 30
 * segundos, y alguien que lo vea por encima del hombro podría reusarlo dentro
 * de esa ventana. Se guarda el último step aceptado y se rechaza reusarlo.
 * Tolerancia ±1 step, ni uno más.
 *
 * ## `first_failed_at` no está en el plan y hace falta
 *
 * El bloqueo es "5 fallos **en 15 minutos**". Eso es una ventana, y un contador
 * solo no puede expresar una ventana: sin saber cuándo empezó la racha, cinco
 * fallos repartidos a lo largo de un mes bloquearían la cuenta de alguien que
 * simplemente escribe mal de vez en cuando. Con la marca, la racha se reinicia
 * al vencer la ventana.
 */
export const migration: Migration = {
  id: "013-staff-totp",
  description: "Secreto TOTP por técnica, anti-repetición y bloqueo",
  statements: [
    `CREATE TABLE IF NOT EXISTS staff_totp (
       user_id          VARCHAR(36) NOT NULL,
       secret_encrypted VARBINARY(255) NOT NULL,
       confirmed_at     DATETIME NULL,
       last_used_step   BIGINT UNSIGNED NULL,
       failed_attempts  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
       first_failed_at  DATETIME NULL,
       locked_until     DATETIME NULL,
       created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (user_id),
       -- Equipo muestra el estado de enrolamiento y quién está bloqueada.
       KEY idx_totp_locked (locked_until),

       -- CASCADE: si la persona deja de existir, su secreto también. Es el
       -- único borrado en cascada que uno *quiere* en este esquema.
       CONSTRAINT fk_totp_user FOREIGN KEY (user_id)
         REFERENCES \`user\` (id) ON DELETE CASCADE ON UPDATE CASCADE
     ) ${TABLE_OPTIONS}`,
  ],
};
