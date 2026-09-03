/**
 * Diagnóstico: la evaluación, en funciones puras.
 *
 * ## Qué es esta pantalla
 *
 * El tablero que hace **sobrevivible un sistema con un solo dueño**. No es un
 * panel de métricas: es la lista de las formas en que este sistema falla en
 * silencio, cada una con su verde o su rojo y su "última vez". Todas las de la
 * lista están documentadas en el plan como modos de falla reales, no como
 * hipótesis:
 *
 * - Los webhooks de EA **no reintentan** (`Webhooks_client::call()` se traga la
 *   excepción y solo la loguea), así que un panel caído diez minutos pierde
 *   esos eventos para siempre.
 * - El push a Google **falla en silencio**: `Synchronization` traga la
 *   excepción, la API responde 201, y `id_google_calendar` vacío es la única
 *   señal.
 * - El pull de Google **borra** citas sin pasar por el controlador, así que no
 *   dispara `appointment_delete` y deja la fila de plata huérfana.
 * - `appointment_status_options` es un ajuste de **texto libre** y el motor de
 *   comisiones depende de él.
 * - `gbs_admin` **es** el libro de caja y no se puede reconstruir de ninguna
 *   otra fuente. Un respaldo viejo es el único riesgo del proyecto que no tiene
 *   arreglo después de ocurrido.
 *
 * ## Por qué la lógica es pura y está acá
 *
 * Porque "rojo a las 48 horas" es una regla, y una regla se fija con un test.
 * La parte que habla con la red y con la base vive en `data.ts`; este archivo
 * recibe hechos y devuelve semáforos. El instante `now` **entra por parámetro**
 * en todo: un check que consulta el reloj por su cuenta da un resultado
 * distinto cada vez y no se puede testear.
 *
 * ## Cuatro niveles, no dos
 *
 * `ok` / `warn` / `down` es lo esperable. El cuarto, **`unknown`**, es el que
 * hace honesta la pantalla: hay cosas que este panel *no puede* verificar
 * —el `secret_header` del webhook no se puede leer por la API de EA, y la marca
 * del respaldo vive en un volumen que el contenedor del panel no monta— y
 * pintarlas de verde sería afirmar una comprobación que nunca se hizo. Un
 * tablero que miente en un renglón deja de servir en todos.
 */

export type CheckLevel = "ok" | "warn" | "down" | "unknown";

export type Check = {
  id: string;
  title: string;
  level: CheckLevel;
  /** Qué significa el estado y, si es malo, qué hacer. */
  detail: string;
  /** "hace 4 minutos", "nunca". Vacío cuando el check no tiene una "última vez". */
  lastSeen?: string;
  /** Cifra que acompaña al semáforo: un conteo, una antigüedad. */
  figure?: string;
};

/** El peor nivel gana. Un solo rojo no puede reportarse como "casi bien". */
export function worstLevel(checks: readonly Check[]): CheckLevel {
  if (checks.some((check) => check.level === "down")) return "down";
  if (checks.some((check) => check.level === "warn")) return "warn";
  if (checks.some((check) => check.level === "unknown")) return "unknown";
  return "ok";
}

// ── "Última vez" ────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Antigüedad en palabras.
 *
 * `null` es **"nunca"**, no "hace un rato". La diferencia importa: "el último
 * respaldo fue nunca" y "el último respaldo fue hace un momento" son las dos
 * puntas del riesgo del proyecto.
 *
 * Una marca en el futuro se rotula como tal en vez de mostrar una antigüedad
 * negativa: pasa cuando el reloj del contenedor y el del servidor de MySQL no
 * coinciden, y eso es en sí mismo un hallazgo.
 */
export function relativeAge(at: Date | null | undefined, now: Date): string {
  if (at === null || at === undefined) return "nunca";

  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms)) return "fecha ilegible";
  if (ms < -MINUTE) return "en el futuro (revisar el reloj)";
  if (ms < MINUTE) return "hace menos de un minuto";

  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    return `hace ${minutes} minuto${minutes === 1 ? "" : "s"}`;
  }

  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    return `hace ${hours} hora${hours === 1 ? "" : "s"}`;
  }

  const days = Math.floor(ms / DAY);
  return `hace ${days} día${days === 1 ? "" : "s"}`;
}

/** Horas cumplidas desde una marca. `null` si no hay marca. */
export function hoursSince(at: Date | null | undefined, now: Date): number | null {
  if (at === null || at === undefined) return null;
  const ms = now.getTime() - at.getTime();
  return Number.isFinite(ms) ? ms / HOUR : null;
}

// ── EA vivo ─────────────────────────────────────────────────────────────────

export function eaApiCheck(input: { ok: boolean; error?: string; at: Date; now: Date }): Check {
  return {
    id: "ea-api",
    title: "La API de Easy!Appointments responde",
    level: input.ok ? "ok" : "down",
    detail: input.ok
      ? "El panel puede escribir en EA. Todas las escrituras van por acá y nunca a sus tablas: es lo que dispara las notificaciones y el sync de Google."
      : `EA no contestó: ${input.error ?? "sin detalle"}. El panel entra en solo lectura — los reportes y la agenda se ven, nada se puede guardar.`,
    lastSeen: relativeAge(input.at, input.now),
  };
}

export function eaDatabaseCheck(input: {
  ok: boolean;
  error?: string;
  at: Date;
  now: Date;
}): Check {
  return {
    id: "ea-db",
    title: "La base de Easy!Appointments se puede leer",
    level: input.ok ? "ok" : "down",
    detail: input.ok
      ? "El usuario de solo lectura sobre easyappointments contesta. Es de donde salen los reportes: la API de EA no agrega."
      : `No se pudo leer easyappointments: ${input.error ?? "sin detalle"}. Sin esto no hay ocupación, ni inasistencia, ni nombres de servicio.`,
    lastSeen: relativeAge(input.at, input.now),
  };
}

// ── Webhook registrado ──────────────────────────────────────────────────────

/** Lo que la API de EA devuelve de un webhook. `secretHeader` **no** viene. */
export type RegisteredWebhook = {
  id: number;
  name: string | null;
  url: string | null;
  /** Lista separada por comas. */
  actions: string | null;
  isSslVerified: boolean | null;
};

/**
 * ¿Está registrado el webhook, apunta acá, y trae la acción que importa?
 *
 * De las dieciocho acciones de EA el handler procesa **una**:
 * `appointment_save`. Las demás se anotan y se responden, así que su ausencia
 * no es un error — pero si falta `appointment_save`, el webhook está mudo y
 * nadie se enteraría hasta que el reconcile nocturno recupere lo perdido.
 *
 * Ojo con el `openapi.yml` de EA: su ejemplo lista `appointment_create`,
 * `appointment_update`, `customer_delete` y `category_create`, que **no son
 * acciones válidas**. Un webhook registrado con esos valores queda mudo sin dar
 * error, y esta comprobación es exactamente la que lo destapa.
 */
export function webhookCheck(input: {
  webhooks: readonly RegisteredWebhook[] | null;
  error?: string;
  /** Sufijo que la URL registrada tiene que traer. */
  expectedPath: string;
  requiredAction: string;
  now: Date;
  at: Date;
}): Check[] {
  if (input.webhooks === null) {
    return [
      {
        id: "webhook",
        title: "El webhook de EA está registrado y apunta acá",
        level: "unknown",
        detail: `No se pudo consultar GET /webhooks: ${input.error ?? "sin detalle"}. Sin eso no se puede afirmar nada del registro.`,
        lastSeen: relativeAge(input.at, input.now),
      },
    ];
  }

  const mine = input.webhooks.filter((hook) =>
    (hook.url ?? "").includes(input.expectedPath),
  );

  const withAction = mine.filter((hook) =>
    (hook.actions ?? "")
      .split(",")
      .map((action) => action.trim())
      .includes(input.requiredAction),
  );

  const registration: Check =
    mine.length === 0
      ? {
          id: "webhook",
          title: "El webhook de EA está registrado y apunta acá",
          level: "down",
          detail: `Ninguno de los ${input.webhooks.length} webhooks registrados apunta a ${input.expectedPath}. El panel solo se enteraría de las citas nuevas en el reconcile de las 03:45.`,
          lastSeen: relativeAge(input.at, input.now),
        }
      : withAction.length === 0
        ? {
            id: "webhook",
            title: "El webhook de EA está registrado y apunta acá",
            level: "down",
            detail: `El webhook apunta acá pero no incluye la acción "${input.requiredAction}": está mudo. Ojo con el ejemplo del openapi.yml de EA, que lista acciones que no existen y dejan el webhook así, sin dar error.`,
            figure: mine[0]?.actions ?? "sin acciones",
            lastSeen: relativeAge(input.at, input.now),
          }
        : {
            id: "webhook",
            title: "El webhook de EA está registrado y apunta acá",
            level: "ok",
            detail: `Registrado con "${input.requiredAction}". Recordar que EA no reintenta: si el panel está caído, esos eventos se pierden y los recupera el reconcile.`,
            figure: mine[0]?.url ?? undefined,
            lastSeen: relativeAge(input.at, input.now),
          };

  // **El `secret_header` no se puede verificar, y se dice.**
  //
  // La columna existe en la tabla de EA, pero su `api_encode()` no la emite y
  // su `api_decode()` no la acepta: el nombre del header solo se configura
  // desde la interfaz de EA o por SQL. Pintar esto de verde sería afirmar una
  // comprobación que la API no permite hacer.
  const secret: Check = {
    id: "webhook-secret",
    title: "El header secreto del webhook",
    level: "unknown",
    detail:
      "No se puede verificar desde acá: la API de EA no expone secret_header — no lo emite al leer ni lo acepta al escribir. Se configura en la interfaz de EA o por SQL, y la única forma de comprobarlo es que un evento real llegue y sea aceptado.",
    figure: "no verificable por API",
  };

  return [registration, secret];
}

// ── Lista de estados ────────────────────────────────────────────────────────

/**
 * ¿Cambió `appointment_status_options`?
 *
 * El motor de comisiones depende de esa lista: decide qué cita cuenta como
 * completada y por lo tanto qué se liquida. Es un ajuste de **texto libre**
 * editable desde la interfaz de EA, y EA **no migra** el `status` de las citas
 * viejas al renombrar uno — así que después de un cambio conviven filas con la
 * cadena vieja y filas con la nueva.
 *
 * El valor se guarda como **JSON array de cadenas** (`'["Booked", "Confirmed",
 * …]'`, con espacios después de las comas en el valor que siembra la migración
 * `043`), y así lo leen `Calendar.php` y `Booking.php`. Un valor que no parsea
 * también es un hallazgo.
 *
 * `unmapped` son las cadenas que el panel no supo traducir en el periodo
 * mirado: es la señal desde el otro lado, y las dos juntas dicen si el cambio
 * ya empezó a producir daño.
 */
export function statusOptionsCheck(input: {
  raw: string | null;
  /** Las que el panel sabe traducir, ya normalizadas por `mapEaStatus`. */
  recognized: (value: string) => boolean;
  unmapped: readonly string[];
  now: Date;
  at: Date;
}): Check {
  const base = {
    id: "status-options",
    title: "La lista de estados de EA sigue siendo la que el panel traduce",
    lastSeen: relativeAge(input.at, input.now),
  };

  if (input.raw === null) {
    return {
      ...base,
      level: "warn",
      detail:
        "EA no tiene el ajuste appointment_status_options. Es una instalación anterior a su migración 043, y entonces el status de cada cita es lo que haya quedado escrito, sin lista que lo respalde.",
    };
  }

  let options: unknown;
  try {
    options = JSON.parse(input.raw);
  } catch {
    return {
      ...base,
      level: "warn",
      detail: `El ajuste existe pero no es JSON válido: ${input.raw.slice(0, 80)}. EA lo lee con json_decode y lo trata como lista vacía, así que las citas nuevas quedarían sin estado.`,
    };
  }

  if (!Array.isArray(options)) {
    return {
      ...base,
      level: "warn",
      detail: "El ajuste existe pero no es una lista. EA espera un arreglo JSON de cadenas.",
    };
  }

  const values = options.filter((value): value is string => typeof value === "string");
  const unknownOptions = values.filter((value) => !input.recognized(value));

  if (unknownOptions.length > 0) {
    return {
      ...base,
      level: "warn",
      detail: `La lista de EA trae ${unknownOptions.length} estado${unknownOptions.length === 1 ? "" : "s"} que el panel no sabe traducir: ${unknownOptions.join(", ")}. Se dibujan punteados en la agenda y salen del denominador de la inasistencia. Hay que agregarlos al mapa de estados o volver a renombrarlos en EA.`,
      figure: values.join(" · "),
    };
  }

  if (input.unmapped.length > 0) {
    return {
      ...base,
      level: "warn",
      detail: `La lista de EA está bien, pero hay citas con estados que no están en ella: ${input.unmapped.map((value) => (value === "" ? "(vacío)" : value)).join(", ")}. EA no migra el status de las citas viejas al renombrar un estado, así que esto es el rastro de un cambio anterior.`,
      figure: values.join(" · "),
    };
  }

  return {
    ...base,
    level: "ok",
    detail: "Las cinco cadenas que EA guarda son las que el panel traduce.",
    figure: values.join(" · "),
  };
}

// ── Plata sin congelar ──────────────────────────────────────────────────────

/**
 * Cuentas sin precio congelado, y cuentas marcadas `fallback`.
 *
 * `fallback` **es** la marca de "esta cita se valoró al precio de lista de hoy
 * porque no había snapshot". Sin ella un cero silencioso sería
 * indistinguible de un cero correcto. El reconcile nocturno las repara, así que
 * un número que no baja de un día al otro significa que el reconcile no está
 * corriendo o que el servicio ya no existe en EA.
 */
export function snapshotCheck(input: {
  withoutSnapshot: number;
  fallback: number;
  total: number;
  now: Date;
  at: Date;
}): Check {
  const problems = input.withoutSnapshot + input.fallback;

  return {
    id: "snapshot",
    title: "Las cuentas tienen su precio congelado",
    // `warn` y no `down` en los dos casos: una cuenta marcada `fallback` **sí
    // tiene** un precio y el reconcile de la noche la repara sola, así que no
    // es un sistema roto — es algo que hay que mirar si mañana sigue igual.
    level: problems === 0 ? "ok" : "warn",
    detail:
      problems === 0
        ? `Las ${input.total} cuentas del periodo tienen snapshot de precio, ninguna en fallback.`
        : `${input.withoutSnapshot} sin snapshot y ${input.fallback} marcadas fallback, de ${input.total}. El reconcile de las 03:45 repara las fallback; si el número no baja mañana, o el reconcile no corrió o el servicio ya no existe en EA.`,
    figure: `${problems} de ${input.total}`,
    lastSeen: relativeAge(input.at, input.now),
  };
}

// ── Espejo de Google ────────────────────────────────────────────────────────

/**
 * Citas sin espejar en Google.
 *
 * Es la **única** señal de que el push falló: `Synchronization` de EA se traga
 * la excepción y solo la escribe en su log, la cita se guarda igual y la API
 * responde 201. Cualquier número distinto de cero es un token vencido o un
 * calendario borrado, y la técnica no está viendo su agenda en el teléfono.
 */
export function googleMirrorCheck(input: {
  /** `null` = no se pudo consultar. */
  unmirrored: number | null;
  windowDays: number;
  error?: string;
  now: Date;
  at: Date;
}): Check {
  if (input.unmirrored === null) {
    return {
      id: "google-mirror",
      title: "Las citas están espejadas en Google",
      level: "unknown",
      detail: `No se pudo consultar: ${input.error ?? "sin detalle"}.`,
    };
  }

  return {
    id: "google-mirror",
    title: "Las citas están espejadas en Google",
    level: input.unmirrored === 0 ? "ok" : "down",
    detail:
      input.unmirrored === 0
        ? `Ninguna cita de los últimos ${input.windowDays} días quedó sin id de Google en técnicas con sync activo.`
        : `${input.unmirrored} cita${input.unmirrored === 1 ? "" : "s"} de los últimos ${input.windowDays} días sin id_google_calendar, en técnicas con google_sync activo. El push falla en silencio —EA responde 201 igual—, así que esto es un token vencido o un calendario borrado, y la técnica no está viendo su agenda en el celular. Se reintenta con un PUT a la cita ("Reenviar a Google").`,
    figure: `${input.unmirrored}`,
    lastSeen: relativeAge(input.at, input.now),
  };
}

// ── Filas de plata huérfanas ────────────────────────────────────────────────

/**
 * Filas de `appointment_finance` cuya cita ya no está en EA.
 *
 * El pull de Google borra la cita **por el modelo y no por el controlador**,
 * así que no dispara `appointment_delete`: la cita desaparece, la fila
 * financiera queda sin par, y no hay ningún aviso. La fila de plata **nunca**
 * se borra en cascada —es el libro de caja—, así que la única salida es verla
 * acá y decidir a mano.
 */
export function orphanCheck(input: {
  /** `null` = no se pudo cruzar (una de las dos bases no contestó). */
  orphans: number | null;
  checked: number;
  now: Date;
  at: Date;
}): Check {
  if (input.orphans === null) {
    return {
      id: "orphans",
      title: "Ninguna cuenta quedó sin su cita en EA",
      level: "unknown",
      detail:
        "El cruce necesita las dos bases —no hay JOIN entre esquemas, se hace en memoria— y una de las dos no contestó.",
    };
  }

  return {
    id: "orphans",
    title: "Ninguna cuenta quedó sin su cita en EA",
    level: input.orphans === 0 ? "ok" : "down",
    detail:
      input.orphans === 0
        ? `Las ${input.checked} cuentas del periodo tienen su cita en EA.`
        : `${input.orphans} de ${input.checked} cuentas apuntan a una cita que ya no existe en EA. El pull de Google borra citas sin disparar webhook, y la fila de plata nunca se borra en cascada porque es el libro de caja: hay que decidir a mano si se anula o si la cita se vuelve a crear.`,
    figure: `${input.orphans}`,
    lastSeen: relativeAge(input.at, input.now),
  };
}

// ── Trabajos programados ────────────────────────────────────────────────────

/**
 * Una corrida de un trabajo, como la guarda `job_run`.
 *
 * Entra como dato y no como fila de la base para que este archivo siga siendo
 * puro: `data.ts` lee la fila y la traduce.
 */
export type JobRunFact = {
  startedAt: Date;
  finishedAt: Date;
  /** `false` = la corrida terminó mal. **No** es lo mismo que no haber corrido. */
  ok: boolean;
  /** Resumen que dejó el job. Se muestra tal cual. */
  summary: string | null;
};

/**
 * El último reconcile.
 *
 * **Esto era un proxy y dejó de serlo.** Antes se leía la marca de tiempo más
 * nueva de una fila que el reconcile hubiera escrito
 * (`MAX(updated_at) WHERE snapshot_source = 'reconcile'`), con un agujero
 * conocido: una corrida que no encontró nada que reparar no deja ninguna fila,
 * así que una semana tranquila se veía igual que un cron muerto. De ahí que el
 * renglón solo pudiera ser amarillo — un rojo que se enciende solo cuando no
 * hubo movimiento es un rojo que se aprende a ignorar.
 *
 * Con `job_run` la pregunta se contesta de frente, y son cuatro respuestas que
 * no se confunden entre sí:
 *
 * - **No hay ninguna corrida** ⇒ `down`. El reconcile no es una red de
 *   seguridad: los webhooks de EA no reintentan, así que es el mecanismo que
 *   garantiza que toda cita quede con su precio congelado. Que nunca haya
 *   corrido es rojo, incluso recién instalado — sobre todo recién instalado, que
 *   es cuando el cron todavía no está.
 * - **La última corrida falló** (`ok = false`) ⇒ `down`, con su motivo. El cron
 *   está vivo y el trabajo se rompe; es un problema distinto y el detalle lo
 *   dice.
 * - **La última corrida es vieja** ⇒ `down`. El cron es diario; pasadas las
 *   horas del umbral, no corrió.
 * - **Corrió, bien y a tiempo** ⇒ `ok`, aunque no haya reparado nada. "No había
 *   nada que hacer" es el resultado normal de una noche tranquila, y ahora se
 *   puede afirmar en vez de sospechar.
 *
 * `lastTouch` sigue entrando, pero ya no decide nada: es la última fila de
 * plata que el reconcile escribió, y se muestra como contexto ("la última vez
 * que hubo algo que reparar"). Que el semáforo no dependa de ella es todo el
 * punto de este cambio.
 */
export function reconcileCheck(input: {
  /**
   * La última corrida. `null` = **nunca corrió**.
   *
   * `undefined` es otra cosa: no se pudo leer `job_run`. `data.ts` degrada esos
   * casos a `unknown` con el motivo, igual que hace con los demás checks que
   * dependen de `gbs_admin`.
   */
  lastRun: JobRunFact | null;
  /** La última fila de plata escrita por el reconcile. Solo contexto. */
  lastTouch?: Date | null;
  /** Horas tras las que se considera que no corrió. El cron es diario. */
  staleHours?: number;
  now: Date;
}): Check {
  const staleHours = input.staleHours ?? 36;
  const lastTouch = input.lastTouch ?? null;

  const repaired =
    lastTouch === null
      ? "Todavía ninguna cuenta fue creada o reparada por el reconcile."
      : `La última cuenta que el reconcile tocó es de ${relativeAge(lastTouch, input.now)}.`;

  const title = "El reconcile nocturno corrió";

  if (input.lastRun === null) {
    return {
      id: "reconcile",
      title,
      // **Rojo, y no amarillo.** Con `job_run` esto ya no es una sospecha: no
      // hay ninguna corrida registrada. El reconcile es el mecanismo que
      // garantiza el precio congelado de cada cita —los webhooks de EA no
      // reintentan— así que sin él el sistema está funcionando sin red.
      level: "down",
      detail:
        "No hay ninguna corrida registrada. Si el panel acaba de entrar en servicio, falta programar el servicio admin-reconcile; si ya estaba, dejó de correr. Mientras no corra, cada webhook perdido es una cita sin precio congelado, y eso se paga en la liquidación.",
      lastSeen: "nunca",
    };
  }

  const age = hoursSince(input.lastRun.startedAt, input.now);
  const when = relativeAge(input.lastRun.startedAt, input.now);
  const summary = input.lastRun.summary ?? "sin resumen";

  if (!input.lastRun.ok) {
    return {
      id: "reconcile",
      title,
      level: "down",
      detail: `La última corrida (${when}) terminó mal: ${summary}. El cron está vivo, el trabajo se rompe. Se puede repetir a mano —es idempotente por diseño— y el error queda en los logs del contenedor.`,
      lastSeen: when,
    };
  }

  // `age === null` es una marca de tiempo ilegible, y también es rojo: una fila
  // de `job_run` que no se puede fechar no prueba que el job corrió, y en este
  // renglón la duda se resuelve del lado seguro. Un verde acá sería la clase de
  // mentira que hace que el tablero entero deje de servir.
  if (age === null || age > staleHours) {
    return {
      id: "reconcile",
      title,
      level: "down",
      detail: `La última corrida fue ${when} y el cron corre a diario. No es una racha tranquila: una corrida sin nada que reparar también deja constancia, así que esto es el job que no está corriendo. Revisar el servicio admin-reconcile.`,
      figure: age === null ? undefined : `${Math.floor(age)} h`,
      lastSeen: when,
    };
  }

  return {
    id: "reconcile",
    title,
    level: "ok",
    detail: `Corrió ${when} y terminó bien: ${summary}. Que no haya reparado nada es el resultado normal de una noche tranquila — y ahora se puede afirmar, no suponer. ${repaired}`,
    lastSeen: when,
  };
}

/**
 * El último push a ingest.
 *
 * Éste **no** es un proxy: `day_close.pushed_to_ingest_at` se escribe cuando el
 * push efectivamente ocurre, y el push es por **cierre diario** y no por cita
 * — Actual Budget deduplica por `imported_id` y no actualiza el monto de una
 * transacción ya importada, así que empujar por cita dejaría a Actual con la
 * cifra vieja para siempre ante cualquier corrección intradía.
 */
export function ingestPushCheck(input: {
  lastPush: Date | null;
  /** Cierres del periodo que todavía no se empujaron. */
  pending: number;
  now: Date;
}): Check {
  return {
    id: "ingest",
    title: "El cierre diario llegó a ingest",
    level: input.pending === 0 ? "ok" : "warn",
    detail:
      input.pending === 0
        ? "No hay cierres pendientes de empujar. El push es por cierre diario, no por cita: así una corrección intradía sale gratis."
        : `${input.pending} cierre${input.pending === 1 ? "" : "s"} sin empujar a ingest. Mientras no se empuje, esa plata no está en Actual Budget. Una corrección posterior al cierre viaja como una fila de ajuste con id propio.`,
    figure: `${input.pending} pendiente${input.pending === 1 ? "" : "s"}`,
    lastSeen: relativeAge(input.lastPush, input.now),
  };
}

/** El último evento que EA mandó. Contexto para el check del webhook. */
export function webhookTrafficCheck(input: { lastEvent: Date | null; now: Date }): Check {
  const age = hoursSince(input.lastEvent, input.now);

  return {
    id: "webhook-traffic",
    title: "Están llegando eventos de EA",
    level: age === null ? "warn" : age > 72 ? "warn" : "ok",
    detail:
      age === null
        ? "El panel nunca recibió un evento de EA. Con el webhook registrado, la primera cita que se guarde en EA tiene que aparecer acá."
        : age > 72
          ? "Hace más de tres días que no llega un evento. Puede ser una semana sin movimiento, o el webhook dejó de alcanzar al contenedor."
          : "El último evento de EA llegó dentro de los últimos tres días.",
    lastSeen: relativeAge(input.lastEvent, input.now),
  };
}

// ── Respaldo ────────────────────────────────────────────────────────────────

/**
 * **Antigüedad del último respaldo. Rojo a las 48 horas.**
 *
 * Es el único renglón de esta pantalla que corresponde a un riesgo sin arreglo
 * posterior: `gbs_admin` es el libro de caja del estudio y **no se puede
 * reconstruir desde ninguna otra fuente** — EA no guarda dinero. El servicio
 * `db-backup` corre a las 03:15 y escribe dos marcas en el volumen de
 * respaldos: `last-run.txt` con la fecha, y `last-status.txt` con el código de
 * salida de los `mysqldump`.
 *
 * Tres estados distintos y ninguno se confunde con otro:
 *
 * - **`unknown`** cuando la marca no se puede leer. Hoy es el caso por defecto:
 *   el servicio `admin` **no monta el volumen `gbs_backups`**, así que el panel
 *   no tiene forma de ver esos archivos. Es una línea en `deploy/compose/gbs-stack.yml`
 *   —`gbs_backups:/backups:ro` en `admin`— que este paquete no puede escribir
 *   porque ese archivo es de A4. Está pedido, y hasta que exista la pantalla
 *   dice exactamente eso en vez de pintar un verde falso.
 * - **`down`** si el último respaldo falló, o si pasó de 48 horas. Un respaldo
 *   que falló en silencio es igual a no tener respaldo.
 * - **`ok`** solo con marca fresca y estado 0.
 */
export const BACKUP_RED_HOURS = 48;

export function backupCheck(input: {
  /** Contenido de `last-run.txt`, o `null` si no se pudo leer. */
  lastRun: Date | null;
  /** Contenido de `last-status.txt`: 0 = los dos dumps salieron bien. */
  status: number | null;
  /** Por qué no se pudo leer, cuando no se pudo. */
  error?: string;
  now: Date;
}): Check {
  const base = { id: "backup", title: "El respaldo de gbs_admin está fresco" };
  const age = hoursSince(input.lastRun, input.now);

  if (age === null) {
    return {
      ...base,
      level: "unknown",
      detail: `No se pudo leer la marca del respaldo: ${input.error ?? "el archivo no existe"}. Hoy el contenedor del panel no monta el volumen de respaldos; falta una línea en el stack (gbs_backups:/backups:ro en el servicio admin). Mientras eso no exista, esta pantalla no puede afirmar nada del respaldo — y gbs_admin es el libro de caja, que no se puede reconstruir de ninguna otra fuente.`,
      lastSeen: "no verificable desde el panel",
    };
  }

  if (input.status !== null && input.status !== 0) {
    return {
      ...base,
      level: "down",
      detail: `El último respaldo terminó con código ${input.status}: al menos uno de los dos mysqldump falló. Un respaldo que falló en silencio es igual a no tener respaldo. Revisar credenciales y grants de BACKUP_GBS_USER y BACKUP_EA_USER.`,
      figure: `código ${input.status}`,
      lastSeen: relativeAge(input.lastRun, input.now),
    };
  }

  if (age > BACKUP_RED_HOURS) {
    return {
      ...base,
      level: "down",
      detail: `El último respaldo tiene ${Math.floor(age)} horas, más de las ${BACKUP_RED_HOURS} que el plan fija como límite. El servicio corre a las 03:15; si no dejó marca en dos noches, hay que mirar los logs de gbs-admin-backup.`,
      figure: `${Math.floor(age)} h`,
      lastSeen: relativeAge(input.lastRun, input.now),
    };
  }

  return {
    ...base,
    level: "ok",
    detail: `Respaldo de hace ${Math.floor(age)} hora${Math.floor(age) === 1 ? "" : "s"}, sin errores. Si BACKUP_OFFSITE_URI está vacío, el respaldo vive en la misma VM que la base y no cubre el modo de falla que importa.`,
    figure: `${Math.floor(age)} h`,
    lastSeen: relativeAge(input.lastRun, input.now),
  };
}

/**
 * Lee la marca de `last-run.txt`.
 *
 * El script la escribe con `date -Iseconds`, que en Alpine da
 * `2026-08-31T03:16:41-05:00`. Se parsea con `Date` porque **eso sí es un
 * instante** —el momento en que corrió el dump— y no una fecha de calendario:
 * es la única parte de este proyecto donde `new Date(iso)` es lo correcto, y el
 * offset viene en la cadena.
 */
export function parseBackupStamp(raw: string | null): Date | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Lee `last-status.txt`. Cualquier cosa que no sea un entero es `null`. */
export function parseBackupStatus(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}
