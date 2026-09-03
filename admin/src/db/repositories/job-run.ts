import type { JobRunRow, NewJobRun } from "../types";
import type { Db } from "./shared";

/**
 * Las corridas de los trabajos programados.
 *
 * Sirve para una sola pregunta, y es la que Diagnóstico no podía responder:
 * **¿esto corrió?** Sin esta tabla el tablero leía la marca de la última fila
 * que el reconcile había escrito, y una corrida que no encontró nada que
 * reparar no deja ninguna — así que una semana tranquila se veía igual que un
 * cron muerto y el renglón solo podía ser amarillo.
 *
 * Append-only, como `audit_log`: solo `record` y lecturas. Una corrida no se
 * edita.
 */

/** Los nombres de trabajo, en un solo lugar. */
export const JOB_RECONCILE = "reconcile";
export const JOB_DAY_CLOSE_PUSH = "day-close-push";

/**
 * `summary` es `VARCHAR(500)`.
 *
 * Se recorta acá y no se deja para MySQL: en modo estricto un valor más largo
 * **rechaza el INSERT**, y perder el registro de que el job corrió por una
 * cadena larga sería el peor intercambio posible — precisamente el dato que
 * esta tabla existe para no perder.
 */
const SUMMARY_MAX = 500;

export type JobRunInput = {
  job: string;
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  /** Resumen legible. Se recorta a 500 caracteres. */
  summary?: string | null;
};

/**
 * La fila, ya lista para insertar.
 *
 * Separada del `insert` para poder testear el recorte y la traducción del
 * booleano sin una base de datos: es la única lógica que hay acá, y es la que
 * decide si el INSERT entra o revienta.
 */
export function jobRunValues(input: JobRunInput): NewJobRun {
  const summary = input.summary ?? null;

  return {
    job: input.job,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    // `TINYINT(1)`, igual que `user.emailVerified`: el esquema no usa BOOLEAN.
    ok: input.ok ? 1 : 0,
    summary: summary === null ? null : summary.slice(0, SUMMARY_MAX),
  };
}

export function jobRunRepository(db: Db) {
  return {
    /** Anota una corrida terminada. */
    async record(input: JobRunInput): Promise<void> {
      await db.insertInto("job_run").values(jobRunValues(input)).execute();
    },

    /**
     * La última corrida de un trabajo, haya salido bien o mal.
     *
     * "La última", no "la última exitosa": el tablero necesita distinguir "no
     * corrió" (no hay fila) de "corrió y falló" (`ok = 0`), y quedarse con la
     * última buena escondería la segunda.
     *
     * Se ordena por `started_at` y se desempata por `id`: dos corridas
     * arrancadas en el mismo milisegundo no pueden dejar el resultado a criterio
     * de MySQL.
     */
    async lastRun(job: string): Promise<JobRunRow | undefined> {
      return db
        .selectFrom("job_run")
        .selectAll()
        .where("job", "=", job)
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
    },

    /** Las últimas corridas de un trabajo, lo más nuevo arriba. */
    async listRecent(job: string, limit = 20): Promise<JobRunRow[]> {
      return db
        .selectFrom("job_run")
        .selectAll()
        .where("job", "=", job)
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
    },
  };
}

export type JobRunRepository = ReturnType<typeof jobRunRepository>;
