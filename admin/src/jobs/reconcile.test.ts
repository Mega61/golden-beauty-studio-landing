import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea";

import { summarizeReconcile, type ReconcileReport } from "./reconcile";

/**
 * Lo puro del reconcile: el resumen que queda en `job_run.summary`.
 *
 * El barrido en sí se prueba contra MySQL y un EA de mentira en
 * `webhook-reconcile.integration.test.ts`. Acá está la línea que Diagnóstico
 * muestra tal cual, y lo que importa de ella es que **una corrida sin trabajo
 * también dice algo**: es la diferencia entera entre "corrió y no había nada
 * que hacer" y "no corrió".
 */

const report = (over: Partial<ReconcileReport> = {}): ReconcileReport => ({
  from: parseEaLocalDate("2026-08-27"),
  till: parseEaLocalDate("2026-11-02"),
  scanned: 41,
  created: 0,
  untouched: 41,
  mirrored: 0,
  repriced: 0,
  repaired: 0,
  frozen: 0,
  fallback: 0,
  startedAt: new Date("2026-09-03T03:15:00Z"),
  finishedAt: new Date("2026-09-03T03:15:42Z"),
  ...over,
});

describe("summarizeReconcile", () => {
  it("una corrida sin nada que reparar deja un resumen igual de completo", () => {
    // Es el caso que el proxy anterior no podía ver: cero filas escritas, cero
    // rastro. Con esto la noche tranquila queda dicha con todas sus cifras.
    const summary = summarizeReconcile(report());

    expect(summary).toContain("2026-08-27→2026-11-02");
    expect(summary).toContain("41 citas revisadas");
    expect(summary).toContain("0 creadas");
    expect(summary).toContain("0 en fallback");
  });

  it("lleva las cifras que hacen accionable el renglón del tablero", () => {
    const summary = summarizeReconcile(
      report({ created: 3, repaired: 1, repriced: 2, mirrored: 4, frozen: 5, fallback: 2 }),
    );

    // `fallback` no es un contador más: son citas sin el precio que EA tenía al
    // agendarlas, y cada una es una comisión que se va a calcular mal si nadie
    // la mira. Tiene que viajar en el resumen.
    expect(summary).toContain("3 creadas");
    expect(summary).toContain("1 reparadas");
    expect(summary).toContain("2 recongeladas");
    expect(summary).toContain("4 espejadas");
    expect(summary).toContain("5 ya cerradas");
    expect(summary).toContain("2 en fallback");
  });

  it("cabe en la columna: `summary` es VARCHAR(500)", () => {
    // El repositorio recorta por si acaso, pero el resumen del caso normal no
    // debería acercarse al límite: si se acerca, es que alguien le metió un
    // dump y la línea dejó de ser legible.
    const grande = summarizeReconcile(
      report({ scanned: 999_999, created: 999_999, untouched: 999_999 }),
    );
    expect(grande.length).toBeLessThan(200);
  });
});
