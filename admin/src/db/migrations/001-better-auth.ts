import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Las cuatro tablas de Better Auth.
 *
 * Van primero porque `appointment_finance.closed_by`, `day_close.closed_by` y
 * `staff_totp.user_id` apuntan a `user`.
 *
 * **Los nombres de columna son camelCase y no se tocan.** Los fija Better Auth:
 * su adaptador de Kysely usa el nombre del campo como nombre de columna.
 * Pasarlos a snake_case obligaría a mantener un mapa de campos sincronizado con
 * cada versión de la librería, y el día que se desincronice el síntoma es
 * "nadie puede iniciar sesión". El resto del esquema sí es snake_case; la
 * frontera está acá y está dicha.
 *
 * `id` es `VARCHAR(36)`: Better Auth genera los ids, no la base.
 */
export const migration: Migration = {
  id: "001-better-auth",
  description: "Tablas de Better Auth: user, session, account, verification",
  statements: [
    `CREATE TABLE IF NOT EXISTS \`user\` (
       id            VARCHAR(36)  NOT NULL,
       name          VARCHAR(255) NOT NULL,
       email         VARCHAR(255) NOT NULL,
       emailVerified TINYINT(1)   NOT NULL DEFAULT 0,
       image         VARCHAR(1024) NULL,
       createdAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updatedAt     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_user_email (email)
     ) ${TABLE_OPTIONS}`,

    `CREATE TABLE IF NOT EXISTS \`session\` (
       id        VARCHAR(36)  NOT NULL,
       userId    VARCHAR(36)  NOT NULL,
       token     VARCHAR(255) NOT NULL,
       expiresAt DATETIME     NOT NULL,
       ipAddress VARCHAR(45)  NULL,
       userAgent VARCHAR(512) NULL,
       createdAt DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updatedAt DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_session_token (token),
       KEY idx_session_user (userId),
       -- Revocar a una persona desde Equipo el día que se va o pierde el
       -- teléfono es borrar sus filas de acá; el CASCADE hace que borrar al
       -- usuario también las lleve.
       CONSTRAINT fk_session_user FOREIGN KEY (userId)
         REFERENCES \`user\` (id) ON DELETE CASCADE ON UPDATE CASCADE
     ) ${TABLE_OPTIONS}`,

    `CREATE TABLE IF NOT EXISTS account (
       id                       VARCHAR(36)  NOT NULL,
       userId                   VARCHAR(36)  NOT NULL,
       accountId                VARCHAR(255) NOT NULL,
       providerId               VARCHAR(64)  NOT NULL,
       accessToken              TEXT         NULL,
       refreshToken             TEXT         NULL,
       idToken                  TEXT         NULL,
       accessTokenExpiresAt     DATETIME     NULL,
       refreshTokenExpiresAt    DATETIME     NULL,
       scope                    TEXT         NULL,
       password                 TEXT         NULL,
       createdAt                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updatedAt                DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_account_provider (providerId, accountId),
       KEY idx_account_user (userId),
       CONSTRAINT fk_account_user FOREIGN KEY (userId)
         REFERENCES \`user\` (id) ON DELETE CASCADE ON UPDATE CASCADE
     ) ${TABLE_OPTIONS}`,

    `CREATE TABLE IF NOT EXISTS verification (
       id         VARCHAR(36)  NOT NULL,
       identifier VARCHAR(255) NOT NULL,
       value      VARCHAR(512) NOT NULL,
       expiresAt  DATETIME     NOT NULL,
       createdAt  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updatedAt  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_verification_identifier (identifier),
       KEY idx_verification_expires (expiresAt)
     ) ${TABLE_OPTIONS}`,
  ],
};
