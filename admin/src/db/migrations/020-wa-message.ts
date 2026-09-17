import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Los mensajes de WhatsApp que el panel manda, y los que decidió no mandar.
 *
 * Agenda Pro manda recordatorios hoy. El día que se cancele, si esto no está, la
 * clienta simplemente deja de recibirlos y la inasistencia sube — es la
 * regresión más visible de todo el corte, y la única que la clienta nota sin
 * que nadie se la cuente.
 *
 * ## `UNIQUE (ea_appointment_id, kind)` es la funcionalidad, no una defensa
 *
 * Un recordatorio duplicado no es un error cosmético: es un mensaje de utilidad
 * facturado dos veces y, sobre todo, es la clienta recibiendo el mismo aviso
 * dos veces por un reintento nuestro. La llave está en el esquema y no en el
 * job porque hay dos caminos que pueden mandar el mismo mensaje —la corrida
 * programada y un reintento manual— y un solo esquema.
 *
 * La fila se inserta **antes** de llamar a Meta, no después. Si se insertara
 * después, un timeout en el que el mensaje sí salió dejaría la fila sin
 * escribir y el siguiente barrido lo mandaría de nuevo. Al revés, un fallo deja
 * una fila en `fallido` que se puede reintentar a propósito — y que cuenta lo
 * que pasó, que es más de lo que cuenta una fila ausente.
 *
 * ## Los estados
 *
 * | Estado | Qué significa |
 * | --- | --- |
 * | `pendiente` | Fila tomada, todavía no salió. Es el estado de un segundo. |
 * | `enviado` | Meta la aceptó. **No** significa que llegó. |
 * | `entregado` | El webhook de estado dijo que llegó al teléfono. |
 * | `leido` | El webhook dijo que la leyeron. |
 * | `fallido` | Meta la rechazó, o la red falló. `error` dice cuál. |
 * | `omitido` | Se decidió no mandarla: opt-out, sin teléfono, fuera de ventana. |
 *
 * `omitido` existe para que "no se mandó" sea un dato y no un hueco. Sin él,
 * una clienta que no recibió recordatorio y una que se dio de baja se ven
 * exactamente igual: sin fila.
 *
 * ## Lo que NO está
 *
 * **El texto del mensaje no se guarda.** Es el mismo principio que
 * `webhook_event`, que guarda el hash del cuerpo y no el cuerpo: el texto lleva
 * el nombre de la clienta y la hora de su cita a una tabla de log sin política
 * de retención. Lo que se guarda es qué plantilla se usó y con qué cita, que es
 * lo que hace falta para depurar.
 *
 * **Sin FK hacia la cita**: la cita vive en `easyappointments`, otro esquema,
 * que esta conexión lee con otro usuario. Es la misma razón por la que
 * `appointment_finance` copia `ea_provider_id` en vez de unirlo.
 */
export const migration: Migration = {
  id: "020-wa-message",
  description: "Recordatorios de WhatsApp: uno por cita y tipo, con su estado",
  statements: [
    `CREATE TABLE IF NOT EXISTS wa_message (
       id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_appointment_id INT UNSIGNED NOT NULL,
       kind              ENUM('recordatorio_24h','recordatorio_2h','confirmacion') NOT NULL,

       -- E.164, como toda identidad de clienta en este panel.
       phone_e164        VARCHAR(20) NOT NULL,
       template_name     VARCHAR(120) NOT NULL,

       status            ENUM('pendiente','enviado','entregado','leido','fallido','omitido')
                           NOT NULL DEFAULT 'pendiente',
       -- El id que devuelve Meta. Es con lo que el webhook de estado encuentra
       -- la fila, así que es único cuando existe.
       provider_message_id VARCHAR(128) NULL,
       error             VARCHAR(500) NULL,
       /** Por qué se omitió. Vacío salvo en \`omitido\`. */
       skip_reason       VARCHAR(120) NULL,

       scheduled_for     DATETIME NOT NULL,
       sent_at           DATETIME NULL,
       updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- Un mensaje de cada tipo por cita. Es lo que impide que un reintento le
       -- mande a la clienta el mismo aviso dos veces.
       UNIQUE KEY uq_wa_appointment_kind (ea_appointment_id, kind),
       -- El webhook de estado llega con el id de Meta y nada más.
       UNIQUE KEY uq_wa_provider_id (provider_message_id),
       -- "Qué hay pendiente de mandar", que es la consulta del job.
       KEY idx_wa_status_scheduled (status, scheduled_for),
       KEY idx_wa_phone (phone_e164)
     ) ${TABLE_OPTIONS}`,

    /**
     * La baja. Una fila por número que pidió no recibir más.
     *
     * Tabla aparte y no una columna en `wa_message` porque la baja es de la
     * **persona**, no del mensaje: vale para todos los mensajes futuros,
     * incluidos los de citas que todavía no existen. Y porque la clienta puede
     * darse de baja sin que haya ninguna fila de mensaje suya todavía.
     *
     * Se guarda el número y no un id de EA: la baja tiene que sobrevivir a que
     * alguien borre y recree su ficha, y la identidad de este panel es el
     * teléfono.
     */
    `CREATE TABLE IF NOT EXISTS wa_optout (
       phone_e164 VARCHAR(20) NOT NULL,
       reason     VARCHAR(200) NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (phone_e164)
     ) ${TABLE_OPTIONS}`,
  ],
};
