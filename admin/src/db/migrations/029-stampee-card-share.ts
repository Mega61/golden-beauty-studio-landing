import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **A quién ya se le mandó el link de su tarjeta de sellos.**
 *
 * El CRM crea la tarjeta en Stampee la noche después de la primera visita, y
 * nadie se la manda a la clienta: Stampee no avisa y el link solo vivía dentro
 * de Fidelidad. A 2026-11-06 había clientas nuevas con tarjeta y sellos que
 * nunca la vieron. El panel ahora la manda por WhatsApp (`lib/stampee/card-share.ts`)
 * y esta tabla es lo que le deja saber a quién le falta.
 *
 * Una fila por tarjeta, no por clienta: si la tarjeta se canjea y sale otra, la
 * nueva también hay que mandarla. La llave es el id de la tarjeta en Stampee,
 * sin llave foránea porque la tarjeta vive en otro servicio. Reenviar pisa
 * `sent_at` y `sent_by_user_id`: lo que importa es que alguien la mandó, y cuándo fue
 * la última vez.
 *
 * `sent_by_user_id` sin FK a `user`, como en `wa_message`: borrar a una persona no puede
 * llevarse por delante que la tarjeta ya se mandó.
 */
export const migration: Migration = {
  id: "029-stampee-card-share",
  description: "stampee_card_share: tarjetas de sellos cuyo link ya se mandó por WhatsApp",
  statements: [
    `CREATE TABLE IF NOT EXISTS stampee_card_share (
       stampee_card_id  VARCHAR(120) NOT NULL,
       sent_by_user_id  VARCHAR(36)  NULL,
       sent_at          DATETIME     NOT NULL,

       PRIMARY KEY (stampee_card_id)
     ) ${TABLE_OPTIONS}`,
  ],
};
