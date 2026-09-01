import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * La allowlist. Correo → rol → provider de EA opcional.
 *
 * Es la segunda de las dos compuertas de Workspace (la primera es el claim `hd`
 * más `email_verified`, y esa se verifica en `lib/auth-policy.ts`). Pasar `hd`
 * como parámetro de request es para UX; nunca se confía sin verificar el claim
 * firmado, y aun verificado hace falta que el correo esté acá.
 *
 * **Sin FK hacia `user`**, y no es un olvido: la fila de la allowlist existe
 * antes que la persona entre por primera vez. La dueña autoriza un correo, y
 * Better Auth crea el `user` recién en ese primer login. Una FK la tendría al
 * revés de como se puebla.
 *
 * `ea_provider_id` es el puente entre las dos identidades que conviven a
 * propósito: la cuenta de Workspace con la que se entra al panel, y la cuenta
 * de EA que usa el sync de Google Calendar de cada técnica. Es UNIQUE porque un
 * provider de EA es una persona: dos correos apuntando al mismo provider harían
 * que dos sesiones distintas vieran y cerraran la misma agenda.
 */
export const migration: Migration = {
  id: "002-allowed-user",
  description: "Allowlist de correos autorizados, con rol y provider de EA",
  statements: [
    `CREATE TABLE IF NOT EXISTS allowed_user (
       id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
       email          VARCHAR(255) NOT NULL,
       role           ENUM('owner','admin','staff') NOT NULL,
       ea_provider_id INT UNSIGNED NULL,
       created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_allowed_user_email (email),
       UNIQUE KEY uq_allowed_user_provider (ea_provider_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
