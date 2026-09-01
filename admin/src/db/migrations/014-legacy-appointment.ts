import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Histórico de Agenda Pro, para continuidad de reportes sin ensuciar el
 * calendario de EA.
 *
 * **Forma provisional, y dicho a propósito.** El plan nombra la tabla pero no
 * enumera sus campos, y depende de una decisión pendiente: *qué trae realmente
 * el export de Agenda Pro, y si hay dinero por cita*. De esa respuesta depende
 * si la continuidad de reportes históricos es real o es una promesa vacía. Lo
 * que hay acá es el mínimo que las dos métricas que sí dependen del histórico
 * necesitan:
 *
 * - **"clienta nueva" = sin ninguna cita previa en la unión EA + legacy** →
 *   `client_phone_e164` + `started_at`, indexados juntos.
 * - **retención a 60 días** → lo mismo.
 *
 * `amount_charged` es nullable justamente por la decisión pendiente: `NULL`
 * significa "el export no traía la plata", no "la cita fue gratis". Un cero
 * habría sido una mentira barata que después se suma en un reporte.
 *
 * Los servicios y las técnicas se guardan por **nombre**, no por id: Agenda Pro
 * no comparte identificadores con EA, y fabricar una correspondencia sería
 * inventar datos que después alguien lee como si fueran ciertos.
 *
 * `source_id` es UNIQUE: el import se puede correr dos veces sin duplicar. Es
 * el mismo principio que `ea_appointment_id` en `appointment_finance`.
 *
 * La identidad de la clienta es el **teléfono en E.164**, nunca un correo
 * inventado — la misma regla que rige la deduplicación de clientas en EA.
 */
export const migration: Migration = {
  id: "014-legacy-appointment",
  description: "Histórico importado de Agenda Pro (forma provisional)",
  statements: [
    `CREATE TABLE IF NOT EXISTS legacy_appointment (
       id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       source_id         VARCHAR(64) NOT NULL,
       started_at        DATETIME NOT NULL,
       ended_at          DATETIME NULL,
       client_phone_e164 VARCHAR(20) NULL,
       client_name       VARCHAR(160) NULL,
       service_name      VARCHAR(160) NOT NULL,
       provider_name     VARCHAR(120) NULL,
       amount_charged    INT NULL,
       status            VARCHAR(40) NULL,
       imported_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       UNIQUE KEY uq_legacy_source (source_id),
       KEY idx_legacy_started (started_at),
       -- "¿Esta clienta ya había venido antes?" sobre la unión EA + legacy.
       KEY idx_legacy_phone_started (client_phone_e164, started_at)
     ) ${TABLE_OPTIONS}`,
  ],
};
