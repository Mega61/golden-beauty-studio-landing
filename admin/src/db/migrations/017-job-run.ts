import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * `job_run`: qué trabajo corrió, cuándo, y si terminó bien.
 *
 * ## Por qué existe
 *
 * Porque hasta ahora Diagnóstico no podía distinguir **"el reconcile corrió y
 * no había nada que reparar"** de **"el reconcile no corrió"**. El check leía
 * `MAX(updated_at) WHERE snapshot_source = 'reconcile'` —la marca de la última
 * fila que el job escribió— y una corrida que no encontró trabajo no deja
 * ninguna. Con ese proxy una semana tranquila se ve igual que un cron muerto, y
 * por eso el renglón solo podía ser amarillo: un rojo que se enciende solo en
 * las semanas sin movimiento es un rojo que se aprende a ignorar.
 *
 * El reconcile **no es una red de seguridad**: los webhooks de EA no reintentan
 * (`Webhooks_client::call()` se traga la excepción y solo la loguea), así que es
 * el mecanismo que garantiza que toda cita termine con su precio congelado. Que
 * no se pueda saber si corrió es el hueco más caro del tablero.
 *
 * ## Una fila por corrida, escrita **al terminar**
 *
 * No hay filas "en curso": la fila se escribe al final, con `started_at` y
 * `finished_at` juntos. Un trabajo que muere a la mitad —OOM, reinicio del
 * contenedor— no deja fila, y Diagnóstico lo lee como "no corrió", que es la
 * lectura correcta: no terminó. La alternativa —insertar al empezar y actualizar
 * al terminar— dejaría filas eternamente abiertas que hay que interpretar, y
 * "corriendo desde hace tres días" y "muerto" se verían distintos sin serlo.
 *
 * `ok = 0` es una corrida que **falló**, y es información distinta de la
 * ausencia de fila: el cron está vivo y el trabajo se rompe. Las dos pintan
 * rojo, con motivos que no se confunden.
 *
 * `summary` es el resumen en texto para que el renglón del tablero diga algo
 * ("42 citas revisadas · 0 creadas") sin que el panel tenga que reinterpretar
 * el reporte del job. Es una columna de lectura humana, no un dato del que
 * dependa ningún cálculo: nada de plata se deriva de acá.
 *
 * ## Sin llaves foráneas, como `audit_log`
 *
 * Es un log append-only de procesos, no de personas. Una FK no tendría a dónde
 * apuntar —el cron no es un `user`— y las escrituras tienen que poder ocurrir
 * incluso cuando lo demás está a medio configurar: el valor de esta tabla es
 * justamente que se pueda escribir la noche que algo se rompió.
 */
export const migration: Migration = {
  id: "017-job-run",
  description:
    "Corridas de los trabajos programados: distingue 'no había nada que hacer' de 'no corrió'",
  statements: [
    `CREATE TABLE IF NOT EXISTS job_run (
       id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       -- Namespace corto y estable: 'reconcile', 'day-close-push'. Lo fija
       -- \`repositories/job-run.ts\`, que es el único que escribe acá.
       job         VARCHAR(64) NOT NULL,
       started_at  DATETIME(3) NOT NULL,
       finished_at DATETIME(3) NOT NULL,
       -- 0 = la corrida falló. Distinto de que no haya fila, que es "no corrió".
       ok          TINYINT(1) NOT NULL,
       summary     VARCHAR(500) NULL,
       created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

       PRIMARY KEY (id),
       -- La única consulta que importa: "la última corrida de este trabajo".
       KEY idx_job_run_job (job, started_at)
     ) ${TABLE_OPTIONS}`,
  ],
};
