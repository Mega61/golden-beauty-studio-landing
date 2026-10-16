/**
 * Caché en proceso de las lecturas a Easy!Appointments.
 *
 * ## Por qué existe
 *
 * EA corta a **100 peticiones por IP cada 120 s** (`rate_limit_helper.php`,
 * `$config['rate_limiting'] = true` fijo en el código) y **todo** el tráfico del
 * panel sale de una sola IP: la del contenedor. La reserva pública de la landing
 * —que recibe tráfico pago de Meta— pasa por el panel, y sin caché una clienta
 * mirando tres días gastaba ~25 llamadas. Cuatro clientas a la vez agotaban el
 * cupo, y desde ahí EA le respondía 429 a todo: también a la agenda de la dueña
 * y a la técnica cerrando cuentas. Esto es lo que hace que el cupo lo gaste el
 * número de cosas que cambian, no el número de visitantes.
 *
 * ## Qué garantiza
 *
 * - **TTL**: un valor se sirve sin preguntarle a EA mientras tenga menos de
 *   `ttlMs`. Ver las políticas abajo: 60 s para lo de referencia, 15 s para
 *   citas y horarios.
 * - **Un solo vuelo**: veinte pedidos simultáneos de la misma clave hacen
 *   **una** llamada a EA y comparten la respuesta. Sin esto, un pico de tráfico
 *   con la caché fría pegaría veinte veces igual.
 * - **Lo viejo antes que el error**: si EA responde 429, 5xx, timeout o red
 *   caída y hay un valor de menos de `staleOnErrorMs`, se sirve ese y se avisa
 *   en el log. Un catálogo público que sigue andando mientras EA está
 *   estrangulado es el punto. Tras un fallo, durante `ERROR_COOLDOWN_MS` ni se
 *   reintenta: cada reintento es una petición más contra un cupo ya agotado.
 * - **Invalidación por etiqueta**: una escritura del panel o un webhook de EA
 *   marcan vencido todo lo que dependa de ese recurso. Lo marcado **ya no se
 *   sirve como fresco**, pero sigue disponible como respaldo ante error (con el
 *   mismo tope de edad): mostrar un servicio con el nombre de hace un minuto
 *   mientras EA está caído es mejor que no mostrar el catálogo.
 * - **Una invalidación gana a una lectura en vuelo**: si la lectura empezó
 *   antes de la escritura, su resultado se entrega a quien lo pidió pero **no
 *   se guarda** — lo leyó antes del cambio.
 *
 * ## Es por proceso, y está bien que lo sea
 *
 * Un `Map` en memoria. El panel corre como **un** contenedor con un solo
 * `next start` de larga vida, así que "por proceso" es "por panel": todas las
 * escrituras pasan por el mismo proceso que lee, y la invalidación las ve. Si
 * algún día hubiera dos réplicas, cada una invalidaría solo lo suyo y la otra
 * serviría hasta su TTL; con 60 s de techo sería tolerable, pero habría que
 * pensarlo antes de escalar.
 *
 * Vive en `globalThis` y no en una variable de módulo: Next empaqueta cada ruta
 * por separado y un módulo puede instanciarse más de una vez en el mismo
 * proceso. Una Server Action de la agenda que invalidara *su* copia del `Map`
 * dejaría a la ruta pública sirviendo la vieja. `Symbol.for` es global al
 * proceso, no al bundle.
 */

import { EaApiError } from "./errors";

// ---------------------------------------------------------------------------
// Políticas
// ---------------------------------------------------------------------------

export type CachePolicy = {
  /** Cuánto se sirve sin preguntarle a EA. */
  ttlMs: number;
  /**
   * Hasta qué edad se sirve un valor viejo si EA falla. `0` = nunca: el error
   * sube tal cual.
   */
  staleOnErrorMs: number;
};

/**
 * Servicios, técnicas, categorías, ajustes, periodos bloqueados y bloqueos.
 *
 * 60 s porque cambian cuando alguien los edita, que es pocas veces al día, y
 * toda edición que pase por el panel o dispare webhook los invalida al
 * instante. El TTL solo cubre lo que no avisa (una edición en la interfaz de EA
 * sin webhook registrado). 10 min de respaldo: un catálogo de hace diez minutos
 * es casi siempre el de ahora.
 */
export const REFERENCE_POLICY: CachePolicy = { ttlMs: 60_000, staleOnErrorMs: 10 * 60_000 };

/**
 * Citas y horarios de EA (`appointments`, `availabilities`).
 *
 * 15 s y **sin respaldo viejo**: la agenda muestra "actualizado hace 12 s", y
 * si EA cae tiene que entrar en solo lectura con su aviso, no pintar citas de
 * hace cinco minutos como si fueran de ahora.
 */
export const APPOINTMENTS_POLICY: CachePolicy = { ttlMs: 15_000, staleOnErrorMs: 0 };

/**
 * El resultado ya calculado de la disponibilidad pública.
 *
 * 15 s, y **sí** con respaldo de 2 min. Se puede porque ofrecer un hueco que ya
 * no existe no vende la silla: `reservar/data.ts` vuelve a mirar todo contra EA
 * en fresco antes de escribir y responde "ese horario se ocupó". Lo peor de un
 * hueco viejo es esa respuesta; lo peor de un 503 es una clienta que se va.
 */
export const PUBLIC_AVAILABILITY_POLICY: CachePolicy = {
  ttlMs: 15_000,
  staleOnErrorMs: 2 * 60_000,
};

/** Tras un fallo servido con lo viejo, cuánto se espera antes de reintentar. */
export const ERROR_COOLDOWN_MS = 5_000;

/**
 * Tope de entradas. Las claves son por recurso, día y servicio: un día normal
 * ronda las decenas. 500 es holgura, no un número afinado; lo que importa es
 * que exista un techo y que un barrido de fechas no pueda crecer la memoria
 * sin límite.
 */
export const MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Etiquetas: qué recurso invalida qué
// ---------------------------------------------------------------------------

/** El cálculo de `/api/public/booking/availability`. No es un recurso de EA. */
export const PUBLIC_AVAILABILITY_TAG = "public-availability";

/**
 * Los horarios libres de EA dependen de casi todo: citas, bloqueos, plan de la
 * técnica, duración del servicio, periodos bloqueados y los ajustes de reserva.
 */
const AVAILABILITY_DEPENDENTS = ["availabilities", PUBLIC_AVAILABILITY_TAG] as const;

const INVALIDATES: Record<string, readonly string[]> = {
  appointments: ["appointments", ...AVAILABILITY_DEPENDENTS],
  unavailabilities: ["unavailabilities", ...AVAILABILITY_DEPENDENTS],
  services: ["services", ...AVAILABILITY_DEPENDENTS],
  providers: ["providers", ...AVAILABILITY_DEPENDENTS],
  blocked_periods: ["blocked_periods", ...AVAILABILITY_DEPENDENTS],
  settings: ["settings", ...AVAILABILITY_DEPENDENTS],
  service_categories: ["service_categories"],
  // La agenda trae la clienta adjunta a cada cita con `with=customer`: un
  // cambio de nombre o teléfono tiene que verse en la próxima consulta.
  customers: ["appointments"],
  // Nada cacheado depende de estos.
  secretaries: [],
  admins: [],
  webhooks: [],
};

/**
 * Qué etiquetas vence una escritura sobre `resource`.
 *
 * `null` = recurso desconocido, y quien llama tiene que vaciar todo: ante una
 * ruta que EA agregue mañana, perder la caché entera cuesta unas llamadas;
 * no invalidar cuesta una silla vendida dos veces.
 */
export function tagsInvalidatedBy(resource: string): readonly string[] | null {
  return Object.prototype.hasOwnProperty.call(INVALIDATES, resource) ? INVALIDATES[resource] : null;
}

/** Política de lectura de una colección de EA, o `null` si no se cachea. */
export function readPolicyFor(resource: string): CachePolicy | null {
  switch (resource) {
    case "services":
    case "providers":
    case "service_categories":
    case "settings":
    case "blocked_periods":
    case "unavailabilities":
      return REFERENCE_POLICY;
    case "appointments":
    case "availabilities":
      return APPOINTMENTS_POLICY;
    default:
      // Clientas, admins, webhooks: o son búsquedas por teléfono (cada una
      // distinta) o son pantallas de configuración que nadie consulta en un
      // pico. Cachearlas no ahorra nada y sí puede mentir.
      return null;
  }
}

/** El recurso de una ruta relativa de la API: `providers/3?x` → `providers`. */
export function resourceOfPath(path: string): string {
  return path.split(/[/?]/, 1)[0] ?? path;
}

/**
 * El recurso de una acción de webhook: `blocked_period_save` → `blocked_periods`.
 *
 * Las 18 acciones de EA son `<entidad>_save` / `<entidad>_delete`, y la entidad
 * va en singular. `null` si la acción no tiene esa forma.
 */
export function resourceOfWebhookAction(action: string): string | null {
  const match = /^([a-z_]+)_(save|delete)$/.exec(action);
  if (!match) return null;
  const entity = match[1];
  if (entity === "unavailability") return "unavailabilities";
  if (entity === "service_category") return "service_categories";
  if (entity === "secretary") return "secretaries";
  return `${entity}s`;
}

// ---------------------------------------------------------------------------
// El almacén
// ---------------------------------------------------------------------------

type Entry = {
  value: unknown;
  storedAt: number;
  tags: readonly string[];
  /** Hasta cuándo vale la pena guardarla, como fresca o como respaldo. */
  keepUntil: number;
  /** Lo venció una invalidación: ya no es fresca, sigue siendo respaldo. */
  invalidated: boolean;
  /** Último fallo de EA servido con este valor, para el enfriamiento. */
  failedAt: number | null;
};

type Flight = { promise: Promise<unknown>; tags: readonly string[] };

export type EaCacheStats = {
  /** Servido de memoria, fresco. */
  hits: number;
  /** Fue a EA. */
  misses: number;
  /** Se colgó de una lectura que ya estaba en vuelo. */
  joins: number;
  /** EA falló y se sirvió un valor viejo. */
  staleServed: number;
  invalidations: number;
};

export type EaCacheOptions = {
  now?: () => number;
  maxEntries?: number;
  errorCooldownMs?: number;
  /** Se llama cada vez que se sirve un valor viejo por un error. */
  onStale?: (key: string, error: unknown, ageMs: number) => void;
};

export type EaCache = {
  /**
   * El valor de `key`: de memoria si está fresco, de `load` si no.
   *
   * `canServeStale` decide qué errores justifican servir lo viejo. Por
   * defecto, los transitorios de EA (429, 5xx, timeout, red): un 400 o un 401
   * no se arreglan escondiéndolos.
   */
  read<T>(
    key: string,
    tags: readonly string[],
    policy: CachePolicy,
    load: () => Promise<T>,
    canServeStale?: (error: unknown) => boolean,
  ): Promise<T>;
  /** Vence todo lo que lleve alguna de estas etiquetas. */
  invalidate(tags: readonly string[]): void;
  /** Vence todo. */
  invalidateAll(): void;
  /** Lo que una escritura sobre `resource` tiene que vencer. */
  invalidateResource(resource: string): void;
  stats(): EaCacheStats;
  size(): number;
  /** Solo para tests: vacía de verdad, sin dejar respaldo. */
  clear(): void;
};

export function isTransientEaError(error: unknown): boolean {
  return error instanceof EaApiError && error.isTransient;
}

function defaultOnStale(key: string, error: unknown, ageMs: number): void {
  const reason = error instanceof EaApiError ? `${error.kind} ${error.status ?? ""}`.trim() : "error";
  console.warn(
    `[ea-cache] EA falló (${reason}); se sirve ${key} de hace ${Math.round(ageMs / 1000)} s`,
  );
}

export function createEaCache(options: EaCacheOptions = {}): EaCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const cooldownMs = options.errorCooldownMs ?? ERROR_COOLDOWN_MS;
  const onStale = options.onStale ?? defaultOnStale;

  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  // Contador por etiqueta. Una lectura anota los de sus etiquetas al salir y
  // solo guarda si al volver siguen iguales.
  const generations = new Map<string, number>();
  const stats: EaCacheStats = { hits: 0, misses: 0, joins: 0, staleServed: 0, invalidations: 0 };

  const generationOf = (tag: string) => generations.get(tag) ?? 0;

  function store(key: string, value: unknown, tags: readonly string[], policy: CachePolicy) {
    const t = now();
    // Borrar antes de poner deja el `Map` ordenado por antigüedad, que es lo
    // que usa la poda para elegir a quién sacar.
    entries.delete(key);
    entries.set(key, {
      value,
      storedAt: t,
      tags,
      keepUntil: t + Math.max(policy.ttlMs, policy.staleOnErrorMs),
      invalidated: false,
      failedAt: null,
    });
    prune(t);
  }

  function prune(t: number) {
    if (entries.size <= maxEntries) return;
    for (const [key, entry] of entries) {
      if (entry.keepUntil <= t) entries.delete(key);
    }
    // Si todas siguen vigentes, salen las más viejas.
    for (const key of entries.keys()) {
      if (entries.size <= maxEntries) break;
      entries.delete(key);
    }
  }

  function staleUsable(entry: Entry | undefined, policy: CachePolicy, t: number): entry is Entry {
    return entry !== undefined && policy.staleOnErrorMs > 0 && t - entry.storedAt < policy.staleOnErrorMs;
  }

  function invalidate(tags: readonly string[]) {
    if (tags.length === 0) return;
    stats.invalidations += 1;
    const hit = (entryTags: readonly string[]) => entryTags.some((tag) => tags.includes(tag));

    for (const tag of tags) generations.set(tag, generationOf(tag) + 1);
    for (const entry of entries.values()) {
      if (hit(entry.tags)) entry.invalidated = true;
    }
    // Quien pregunte después de la escritura no se cuelga de una lectura que
    // empezó antes: arranca una nueva.
    for (const [key, flight] of flights) {
      if (hit(flight.tags)) flights.delete(key);
    }
  }

  function invalidateAll() {
    const all = new Set<string>();
    for (const entry of entries.values()) entry.tags.forEach((tag) => all.add(tag));
    for (const flight of flights.values()) flight.tags.forEach((tag) => all.add(tag));
    for (const tags of Object.values(INVALIDATES)) tags.forEach((tag) => all.add(tag));
    invalidate([...all]);
  }

  return {
    read<T>(
      key: string,
      tags: readonly string[],
      policy: CachePolicy,
      load: () => Promise<T>,
      canServeStale: (error: unknown) => boolean = isTransientEaError,
    ): Promise<T> {
      const t = now();
      const entry = entries.get(key);

      if (entry && !entry.invalidated && t - entry.storedAt < policy.ttlMs) {
        stats.hits += 1;
        return Promise.resolve(entry.value as T);
      }

      // EA acaba de fallar y lo viejo todavía sirve: no se le insiste.
      if (
        staleUsable(entry, policy, t) &&
        entry.failedAt !== null &&
        t - entry.failedAt < cooldownMs
      ) {
        stats.staleServed += 1;
        return Promise.resolve(entry.value as T);
      }

      const inFlight = flights.get(key);
      if (inFlight) {
        stats.joins += 1;
        return inFlight.promise as Promise<T>;
      }

      stats.misses += 1;
      const seen = tags.map(generationOf);

      // `Promise.resolve().then(load)` y no `load()` directo: si `load` lanzara
      // de forma síncrona, el `finally` correría antes de que `promise` exista.
      const promise: Promise<T> = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            const unchanged = tags.every((tag, i) => generationOf(tag) === seen[i]);
            if (unchanged) store(key, value, tags, policy);
            return value;
          },
          (error: unknown) => {
            const at = now();
            const current = entries.get(key);
            if (staleUsable(current, policy, at) && canServeStale(error)) {
              current.failedAt = at;
              stats.staleServed += 1;
              onStale(key, error, at - current.storedAt);
              return current.value as T;
            }
            throw error;
          },
        )
        .finally(() => {
          if (flights.get(key)?.promise === promise) flights.delete(key);
        });

      flights.set(key, { promise, tags });
      return promise;
    },

    invalidate,
    invalidateAll,
    invalidateResource(resource) {
      const tags = tagsInvalidatedBy(resource);
      if (tags === null) invalidateAll();
      else invalidate(tags);
    },

    stats: () => ({ ...stats }),
    size: () => entries.size,

    clear() {
      entries.clear();
      flights.clear();
      generations.clear();
    },
  };
}

const GLOBAL_KEY = Symbol.for("gbs.admin.ea-cache");

/** La caché del proceso. Ver "Es por proceso" en el encabezado. */
export function sharedEaCache(): EaCache {
  const holder = globalThis as unknown as Record<symbol, EaCache | undefined>;
  return (holder[GLOBAL_KEY] ??= createEaCache());
}
