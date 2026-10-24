import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **Manos y pies que no son combo, en una sola cita.**
 *
 * EA admite un servicio por cita. Hasta acá un par sin combo (esculpidas +
 * semipermanente pies, tradicional manos + tradicional pies) se guardaba como
 * dos citas pegadas, y la dueña lo pidió al revés el 2026-10-24: **una reserva,
 * un bloque** en la agenda. Dos bloques eran dos "Llegó", dos cuentas que
 * cerrar, y dos decisiones de promo (la segunda cuenta ya no era primera
 * visita).
 *
 * Así que la cita de EA lleva el servicio principal y dura lo que duran todos,
 * y acá queda qué otro(s) servicio(s) se pactaron. La agenda los muestra en el
 * bloque ("Esculpidas en acrílico + Semipermanente pies"), la hoja de la
 * cuenta los trae ya agregados, y los mensajes por WhatsApp los nombran.
 *
 * **No es plata**: no lleva precio. Cada adicional se cobra al precio del
 * catálogo al cerrar la cuenta, como un servicio agregado a mano en la hoja.
 *
 * Sin llave foránea a EA: la cita vive en otro esquema. `position` conserva el
 * orden en que se agregaron, que es el orden en que se muestran.
 */
export const migration: Migration = {
  id: "028-appointment-planned-service",
  description: "appointment_planned_service: servicios adicionales de una cita (manos + pies sin combo)",
  statements: [
    `CREATE TABLE IF NOT EXISTS appointment_planned_service (
       ea_appointment_id  INT UNSIGNED NOT NULL,
       position           TINYINT UNSIGNED NOT NULL,
       ea_service_id      INT UNSIGNED NOT NULL,
       created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (ea_appointment_id, position)
     ) ${TABLE_OPTIONS}`,
  ],
};
