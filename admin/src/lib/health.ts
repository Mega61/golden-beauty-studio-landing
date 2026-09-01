/**
 * Reporte de salud del panel.
 *
 * Es una función pura sobre una lista de comprobaciones para que se pueda
 * testear sin levantar nada: la lógica que decide "sano / degradado / caído" es
 * la parte que importa, y no debería necesitar un MySQL para verificarse.
 *
 * Los paquetes siguientes le agregan comprobaciones reales — A2 la de
 * `mysql-transversal`, A1 la de la API de EA — registrándolas en `CHECKS`. La
 * forma de la respuesta no cambia, así que el `healthcheck` del compose y el
 * tile de Diagnóstico se escriben una vez.
 */

export type CheckStatus = "ok" | "degraded" | "down";

export type HealthCheck = {
  name: string;
  status: CheckStatus;
  detail?: string;
};

export type HealthReport = {
  status: CheckStatus;
  time: string;
  /**
   * Zona horaria **efectiva** del proceso, que tiene que ser America/Bogota:
   * EA guarda datetimes locales sin zona, y un panel en UTC desfasa cinco
   * horas todos los cálculos de fecha.
   *
   * Se lee de `Intl`, no de `process.env.TZ`, y la diferencia importa: la
   * variable puede venir vacía y la zona ser correcta igual (la hereda del
   * sistema), o venir puesta y no ser lo que el runtime aplicó. `Intl` reporta
   * lo que el proceso realmente está usando, que es lo único que sirve para
   * diagnosticar.
   */
  timezone: string;
  checks: HealthCheck[];
};

/** La zona que el proceso está usando de verdad. */
export function resolvedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * El peor estado gana. Una sola dependencia caída no puede reportarse como
 * "degradado" solo porque las demás estén bien: el contenedor tiene que salir
 * unhealthy para que Portainer lo muestre en rojo.
 */
export function worstStatus(checks: readonly HealthCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "down")) return "down";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  return "ok";
}

/**
 * Comprobaciones registradas. Vacío = solo se verifica que el proceso responde,
 * que es exactamente lo que el andamiaje puede afirmar hoy.
 */
const CHECKS: Array<() => Promise<HealthCheck>> = [];

export async function buildHealthReport(
  now: Date = new Date(),
): Promise<HealthReport> {
  const checks = await Promise.all(CHECKS.map((run) => run()));

  return {
    status: worstStatus(checks),
    time: now.toISOString(),
    timezone: resolvedTimeZone(),
    checks,
  };
}
