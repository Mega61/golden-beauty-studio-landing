import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * **Recuperar clientas: "Te extrañamos".**
 *
 * A una clienta que dejó de venir se le regala una tarjeta de sellos nueva (de
 * una campaña de Stampee que ya nace con sellos) y el 10 % de primera visita en
 * su próxima cita, y se le manda todo por WhatsApp desde el panel
 * (`/clientes/recuperar`, `lib/winback.ts`).
 *
 * - `winback_config`: una sola fila (`id = 1`) con la campaña de Stampee, el
 *   texto del mensaje y las condiciones del regalo. La dueña lo cambia desde la
 *   pantalla, sin deploy.
 * - `winback_offer`: una fila por clienta (llave: su teléfono E.164) a la que
 *   ya se le mandó el regalo. Es lo que evita regalarle dos tarjetas, y lo que
 *   la cuenta y `/reservar` miran para ponerle el 10 %. El 10 % se gasta solo:
 *   vale para la **primera visita atendida después de `sent_at`** y antes de
 *   `expires_on`, sin columna de "usado" que alguien pueda olvidar marcar.
 *   `discount_percent` es la foto de lo que se le prometió al mandarlo (0 = sin
 *   descuento): cambiar la configuración después no le quita lo prometido.
 *
 * Sin FK hacia Stampee (otro servicio) ni hacia `user` (borrar a una persona no
 * puede borrar que el regalo ya se mandó), como `stampee_card_share`.
 */
export const migration: Migration = {
  id: "032-winback",
  description: "winback_config + winback_offer: tarjeta de regalo y 10 % para clientas que no vuelven",
  statements: [
    `CREATE TABLE IF NOT EXISTS winback_config (
       id                   TINYINT      NOT NULL,
       stampee_campaign_id  VARCHAR(120) NULL,
       message_template     TEXT         NULL,
       discount_enabled     TINYINT(1)   NOT NULL DEFAULT 1,
       valid_days           INT          NULL,
       lapsed_days          INT          NOT NULL DEFAULT 45,
       updated_by_user_id   VARCHAR(36)  NULL,
       updated_at           DATETIME     NOT NULL,

       PRIMARY KEY (id)
     ) ${TABLE_OPTIONS}`,
    `CREATE TABLE IF NOT EXISTS winback_offer (
       phone_e164              VARCHAR(20)  NOT NULL,
       client_name             VARCHAR(200) NULL,
       stampee_customer_id     VARCHAR(120) NULL,
       stampee_card_id         VARCHAR(120) NULL,
       stampee_card_unique_id  VARCHAR(120) NULL,
       gifted_stamps           INT          NOT NULL DEFAULT 0,
       discount_percent        INT          NOT NULL DEFAULT 0,
       expires_on              DATE         NULL,
       sent_by_user_id         VARCHAR(36)  NULL,
       sent_at                 DATETIME     NOT NULL,
       last_sent_at            DATETIME     NOT NULL,

       PRIMARY KEY (phone_e164),
       KEY idx_winback_offer_sent_at (sent_at)
     ) ${TABLE_OPTIONS}`,
  ],
};
