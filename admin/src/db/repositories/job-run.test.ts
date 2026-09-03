import { describe, expect, it } from "vitest";

import { JOB_DAY_CLOSE_PUSH, JOB_RECONCILE, jobRunValues } from "./job-run";

/**
 * Lo que se puede afirmar de `job_run` **sin** una base de datos: la fila que
 * se va a insertar.
 *
 * Las consultas se verifican contra MySQL real en `db/schema.integration.test.ts`.
 * Acá está la única lógica del repositorio, y es la que decide si el INSERT
 * entra o revienta: el recorte de `summary` y la traducción del booleano.
 */

const STARTED = new Date("2026-09-03T03:15:00.000Z");
const FINISHED = new Date("2026-09-03T03:15:42.500Z");

describe("jobRunValues", () => {
  it("guarda las dos marcas y el nombre del trabajo tal cual", () => {
    // La fila se escribe **al terminar**, con las dos marcas juntas: no hay
    // corridas "en curso", y un job que muere a la mitad no deja fila — que es
    // lo que Diagnóstico lee como "no corrió".
    expect(
      jobRunValues({
        job: JOB_RECONCILE,
        startedAt: STARTED,
        finishedAt: FINISHED,
        ok: true,
        summary: "42 citas revisadas · 0 creadas",
      }),
    ).toEqual({
      job: "reconcile",
      started_at: STARTED,
      finished_at: FINISHED,
      ok: 1,
      summary: "42 citas revisadas · 0 creadas",
    });
  });

  it("`ok: false` es un 0, no un `false`", () => {
    // La columna es `TINYINT(1)`, igual que `user.emailVerified`: este esquema
    // no usa BOOLEAN. Un `false` de JavaScript llegaría al driver y no es lo
    // que la columna espera.
    const row = jobRunValues({
      job: JOB_DAY_CLOSE_PUSH,
      startedAt: STARTED,
      finishedAt: FINISHED,
      ok: false,
      summary: "ingest respondió 502",
    });

    expect(row.ok).toBe(0);
    expect(row.job).toBe("day-close-push");
  });

  it("sin resumen la columna queda en `NULL`, no en cadena vacía", () => {
    expect(jobRunValues({ job: "x", startedAt: STARTED, finishedAt: FINISHED, ok: true }).summary)
      .toBeNull();
    expect(
      jobRunValues({
        job: "x",
        startedAt: STARTED,
        finishedAt: FINISHED,
        ok: true,
        summary: null,
      }).summary,
    ).toBeNull();
  });

  it("**recorta el resumen a 500 caracteres** en vez de dejar que el INSERT falle", () => {
    // En modo estricto MySQL rechaza un valor más largo que la columna. Perder
    // el registro de que el job corrió por una cadena larga sería el peor
    // intercambio posible: es justo el dato que esta tabla existe para no
    // perder. Un error de un job puede traer un stack entero.
    const largo = "e".repeat(4_000);
    const row = jobRunValues({
      job: JOB_RECONCILE,
      startedAt: STARTED,
      finishedAt: FINISHED,
      ok: false,
      summary: largo,
    });

    expect(row.summary).toHaveLength(500);
    expect(row.summary).toBe("e".repeat(500));
  });

  it("un resumen de exactamente 500 caracteres pasa entero", () => {
    const justo = "x".repeat(500);
    expect(
      jobRunValues({
        job: JOB_RECONCILE,
        startedAt: STARTED,
        finishedAt: FINISHED,
        ok: true,
        summary: justo,
      }).summary,
    ).toBe(justo);
  });
});
