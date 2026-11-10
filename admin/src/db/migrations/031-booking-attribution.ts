import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **De dónde llegó cada reserva hecha desde la página.**
 *
 * EA no tiene ninguna columna de origen (verificado en la fuente de 1.6.0), así
 * que "¿cuántas reservas trajo la bio de Instagram este mes?" no tenía
 * respuesta. La landing guarda los `utm_*` y el dominio que la refirió cuando
 * alguien entra, y los manda con la reserva; el panel los anota acá.
 *
 * Una fila por cita, y **solo** de las reservas web: las que agenda el estudio
 * desde el panel (WhatsApp, llamada) no tienen fila, y eso es un dato, no un
 * hueco. Se guarda lo crudo y no el canal ya decidido: la regla que convierte
 * `instagram/bio` en "Instagram" vive en `lib/booking-attribution.ts` y puede
 * mejorar sin reescribir filas viejas.
 *
 * Sin FK: la cita vive en EA.
 */
export const migration: Migration = {
  id: "031-booking-attribution",
  description: "booking_attribution: utm y referente de cada reserva hecha desde la página",
  statements: [
    `CREATE TABLE IF NOT EXISTS booking_attribution (
       ea_appointment_id  INT UNSIGNED NOT NULL,
       utm_source         VARCHAR(100) NULL,
       utm_medium         VARCHAR(100) NULL,
       utm_campaign       VARCHAR(100) NULL,
       utm_content        VARCHAR(100) NULL,
       referrer_host      VARCHAR(255) NULL,
       landing_path       VARCHAR(255) NULL,
       click_id           VARCHAR(20)  NULL,
       created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (ea_appointment_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
