/**
 * Cuántas peticiones HTTP le hace el panel a EA, por método y recurso.
 *
 * Existe para poder **medir** el cupo de EA (100 por IP cada 120 s, ver
 * `cache.ts`) en vez de adivinarlo: cuánto gasta un catálogo, una consulta de
 * horarios, un refresco de la agenda. Es un contador en memoria, por proceso,
 * en `globalThis` por la misma razón que la caché.
 *
 * En desarrollo cada llamada deja una línea en el log del servidor
 * (`[ea] GET services → 200 · #12`), que es lo que se mira al probar un cambio.
 * En producción no se imprime nada salvo que `EA_LOG_CALLS=1`: el contenedor
 * no necesita una línea por petición, pero el día que haya que diagnosticar
 * un 429 se prende sin tocar código. `EA_LOG_CALLS=0` lo apaga también en dev.
 */

type Stats = { total: number; byKey: Record<string, number> };

const GLOBAL_KEY = Symbol.for("gbs.admin.ea-call-stats");

function holder(): Stats {
  const g = globalThis as unknown as Record<symbol, Stats | undefined>;
  return (g[GLOBAL_KEY] ??= { total: 0, byKey: {} });
}

function shouldLog(env: Record<string, string | undefined> = process.env): boolean {
  if (env.EA_LOG_CALLS === "1") return true;
  if (env.EA_LOG_CALLS === "0") return false;
  return env.NODE_ENV === "development";
}

/** Anota una petición que de verdad salió a la red. */
export function recordEaCall(method: string, resource: string, status: number | string): void {
  const stats = holder();
  const key = `${method} ${resource}`;
  stats.total += 1;
  stats.byKey[key] = (stats.byKey[key] ?? 0) + 1;

  if (shouldLog()) {
    console.info(`[ea] ${key} → ${status} · #${stats.total}`);
  }
}

/** Una copia del contador. */
export function eaCallStats(): Stats {
  const stats = holder();
  return { total: stats.total, byKey: { ...stats.byKey } };
}

/** Solo para tests. */
export function resetEaCallStats(): void {
  const stats = holder();
  stats.total = 0;
  stats.byKey = {};
}
