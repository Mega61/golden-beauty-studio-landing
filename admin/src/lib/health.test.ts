import { describe, expect, it } from "vitest";

import { buildHealthReport, worstStatus, type HealthCheck } from "./health";

const check = (status: HealthCheck["status"]): HealthCheck => ({
  name: "x",
  status,
});

describe("worstStatus", () => {
  it("sin comprobaciones, está sano", () => {
    expect(worstStatus([])).toBe("ok");
  });

  it("una caída manda sobre todo lo demás", () => {
    // El caso que importa: el promedio no existe. Si MySQL está abajo, el
    // contenedor sale unhealthy aunque las otras tres comprobaciones pasen.
    expect(worstStatus([check("ok"), check("degraded"), check("down")])).toBe(
      "down",
    );
  });

  it("degradado gana sobre sano", () => {
    expect(worstStatus([check("ok"), check("degraded")])).toBe("degraded");
  });

  it("todas sanas, sano", () => {
    expect(worstStatus([check("ok"), check("ok")])).toBe("ok");
  });
});

describe("buildHealthReport", () => {
  it("reporta la hora del instante que se le pasa, en ISO", async () => {
    const report = await buildHealthReport(new Date("2026-08-31T15:04:05Z"));

    expect(report.status).toBe("ok");
    expect(report.time).toBe("2026-08-31T15:04:05.000Z");
    expect(report.checks).toEqual([]);
  });

  it("reporta la zona EFECTIVA, no la variable de entorno", async () => {
    // Es la forma de cazar un contenedor corriendo en UTC: EA guarda datetimes
    // locales sin zona, y cinco horas de desfase se manifiestan como "los
    // totales del cierre no cuadran".
    //
    // Se lee de `Intl` a propósito. `process.env.TZ` miente en los dos
    // sentidos: en Git Bash sobre Windows un prefijo `TZ=...` no llega al
    // proceso (queda `undefined`) aunque la zona efectiva sí sea la correcta.
    // Un healthcheck que reportara "unset" ahí sería ruido permanente.
    const report = await buildHealthReport();

    expect(report.timezone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );

    // Que sea una zona que `Intl` sepa resolver, no que tenga forma de
    // "Region/Ciudad": bajo `TZ=UTC` el valor es "UTC", sin barra, y una
    // aserción de forma haría fallar la suite en CI por un test mal escrito y
    // no por un problema real.
    expect(() =>
      new Intl.DateTimeFormat("es-CO", { timeZone: report.timezone }).format(),
    ).not.toThrow();
  });
});
