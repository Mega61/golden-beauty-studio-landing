import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Cuánto se invirtió en anuncios, por mes y por canal.
 *
 * Es el denominador que faltaba: el reporte "Clientas nuevas vs. que vuelven"
 * ya decía **cuántas** llegaron, pero "¿la pauta se paga sola?" necesita
 * además **cuánto costó** traerlas, y ese número no vive en ninguna parte del
 * sistema — ni EA, ni `appointment_finance`, ni Actual Budget lo separan. Lo
 * escribe la dueña a mano desde el reporte, una vez al mes, copiándolo del
 * Administrador de anuncios.
 *
 * ## Por qué por mes y no por campaña o por día
 *
 * Es la granularidad a la que la dueña conoce el dato (la factura de Meta es
 * mensual) y a la que el reporte decide. Una tabla por campaña pediría una
 * disciplina de captura que nadie va a sostener, y un dato a medio cargar es
 * peor que uno grueso: el costo por clienta saldría bajo justo los meses en que
 * alguien se olvidó de anotar.
 *
 * `month` es `CHAR(7)` `"YYYY-MM"` y no un `DATE`: un mes es calendario, no un
 * instante, y el "primer día del mes a medianoche" es justo la conversión donde
 * nace el bug de cinco horas que este proyecto persigue desde el principio.
 * Ordena bien como texto, que es lo único que se le pide.
 *
 * La llave es `(month, channel)`: guardar la inversión de marzo en Meta dos
 * veces **reemplaza** la cifra en vez de sumarla, que es lo que espera quien
 * corrige un número mal digitado. Lo que había antes queda en `audit_log`.
 *
 * `amount_cop` es `INT UNSIGNED` en pesos enteros, como toda la plata del
 * esquema: una inversión negativa no existe, y un cero es una cifra legítima
 * ("este mes no se pautó") distinta de no tener fila ("no se sabe").
 *
 * `updated_by` sin llave foránea, igual que `audit_log.actor_user_id`: borrar
 * una cuenta no puede llevarse por delante la cifra que esa persona anotó.
 */
export const migration: Migration = {
  id: "023-ad-spend",
  description: "Inversión mensual en anuncios, para el costo por clienta nueva",
  statements: [
    `CREATE TABLE IF NOT EXISTS ad_spend (
       month       CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
       channel     ENUM('meta','google','otro') NOT NULL DEFAULT 'meta',
       amount_cop  INT UNSIGNED NOT NULL,
       notes       VARCHAR(500) NULL,
       updated_by  VARCHAR(36) NULL,
       updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (month, channel),
       CONSTRAINT ck_ad_spend_month CHECK (month REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')
     ) ${TABLE_OPTIONS}`,
  ],
};
