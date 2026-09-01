/**
 * Detección de choques — corre **antes de cada escritura**, porque EA no lo hace.
 *
 * `Calendar.php` (el backend propio de EA) llama a `has_provider_conflict()` y
 * devuelve `{success:false, conflict:true}` salvo que se mande `force_save`.
 * `Appointments_api_v1::store()` y `::update()` **no tienen ese chequeo**:
 * aceptan una cita encima de otra sin protestar (hueco #4 del plan). Como todas
 * nuestras escrituras van por la API REST, la detección de choques es nuestra.
 *
 * ## El resultado no es un booleano
 *
 * La UI tiene que decir **qué** choca y **con qué**, y ofrecer "Guardar de
 * todas formas" — el mismo modelo mental del `force_save` de EA. Un `false` no
 * alcanza para escribir "Lina ya tiene a Marcela de 2 a 3:30". Por eso
 * `checkConflicts()` devuelve un `ConflictReport` con una lista de motivos, y
 * cada motivo trae la ventana exacta y los objetos con los que choca.
 *
 * ## Dos severidades, las dos salvables
 *
 * El plan no fija la escala, así que se fija acá y se deja dicho:
 *
 * - **`hard`** — físicamente imposible: la técnica ya está con otra clienta, no
 *   queda puesto libre, se pasa la capacidad del servicio. Guardar igual deja
 *   la agenda describiendo algo que no puede ocurrir.
 * - **`soft`** — política de horario: fuera del plan, en un descanso, en un
 *   bloqueo o en una indisponibilidad. Guardar igual es una decisión normal
 *   ("Lina se queda media hora más hoy") y la agenda queda consistente.
 *
 * **Las dos se pueden forzar.** EA solo tiene un `force_save` y no distingue;
 * la severidad es para el tono del diálogo y para el orden de los motivos, no
 * para bloquear. Un motor que impidiera guardar dejaría a la recepción sin
 * salida frente a un caso real y la empujaría a arreglarlo por fuera del panel,
 * que es donde el dato deja de existir.
 *
 * ## Límites exactos
 *
 * Solape estricto: `existing.start < new.end && existing.end > new.start`. Una
 * cita que termina justo cuando empieza otra **no** choca. Es literalmente la
 * consulta de `Appointments_model::has_provider_conflict()` y es lo que pide
 * § Interacción.
 *
 * ## Lo que este módulo NO hace
 *
 * No lee la base, no llama a EA y no formatea moneda ni horas. Recibe los
 * datos ya cargados y devuelve estructura. Quien la muestre decide el texto
 * final; los `message` de acá son el fallback y el texto de los tests.
 */

import {
  compareEaLocal,
  parseEaLocalDate,
  type EaLocalDate,
  type EaLocalDateTime,
} from "./ea/datetime";
import type { Appointment, BlockedPeriod, Unavailability } from "./ea/types";
import { resolveWorkingWindow, type GridProvider } from "./calendar-layout";

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** La cita que se está por escribir. */
export type ConflictCandidate = {
  /**
   * Id de la cita cuando se está **moviendo** una existente. Sin él, mover una
   * cita cinco minutos choca contra ella misma — el mismo
   * `exclude_appointment_id` que pasa `Calendar.php`.
   */
  id?: number | null;
  providerId: number;
  serviceId: number | null;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
};

/**
 * Lo que la detección necesita saber de un servicio.
 *
 * **No es `Service` de A1**, y no por capricho: a `Service` le sobra casi todo
 * (precio, color, descripción) y le falta la única pieza que decide si una
 * cita cabe en un puesto especializado — la categoría de `pricing.ts`, que EA
 * no conoce y que trae `service_map` de A2. Un tipo de entrada mínimo mantiene
 * este módulo puro y hace que un test se escriba en una línea.
 */
export type ServiceCapacity = {
  id: number;
  /**
   * `attendantsNumber` de EA: cuántas clientas puede atender **una** técnica a
   * la vez para ese servicio. `null` o menor que 1 se lee como 1.
   */
  attendantsNumber: number | null;
  /** Categoría de `pricing.ts`. `null` = no se sabe. */
  category: string | null;
};

/**
 * Un puesto físico. Espeja la tabla `station` de A2 sin importarla: `db/` trae
 * `server-only` por el cliente de Kysely y este módulo tiene que poder correr
 * también del lado del navegador, cuando C1 valide antes de mandar el PUT.
 */
export type StationSlot = {
  id: number;
  name: string;
  /** Categorías que acepta, o `null` = cualquiera. Hoy las dos son `null`. */
  allows: readonly string[] | null;
};

export type ConflictInput = {
  candidate: ConflictCandidate;
  /**
   * **Todas** las citas del rango, de todas las técnicas — no solo las de la
   * columna del candidato. Sin las de las demás, la cuenta de puestos libres
   * da de más y la agenda vende una silla que no existe.
   */
  appointments?: readonly Appointment[];
  unavailabilities?: readonly Unavailability[];
  blockedPeriods?: readonly BlockedPeriod[];
  /** Plan de trabajo y excepciones de la técnica del candidato. */
  provider?: Pick<GridProvider, "workingPlan" | "workingPlanExceptions"> | null;
  services?: readonly ServiceCapacity[] | ReadonlyMap<number, ServiceCapacity>;
  /**
   * Los puestos del estudio.
   *
   * Omitirlo **salta** el chequeo (el que llama declara que no le interesa).
   * Pasar un arreglo vacío es distinto: cero sillas significa que nada cabe, y
   * eso se reporta. La diferencia importa porque un `[]` accidental —una
   * consulta que falló y devolvió vacío— tiene que verse de inmediato en vez de
   * apagar en silencio la restricción más fácil de olvidar del proyecto.
   */
  stations?: readonly StationSlot[];
  /**
   * Estados cuyo texto libre significa que la silla quedó libre.
   *
   * ⚠ **EA no hace esto.** `has_provider_conflict()` consulta la tabla
   * `appointments` sin mirar `status`: para EA, una cita cancelada sigue
   * ocupando el horario. Para el estudio no, y por eso acá sí se descuentan.
   * Se compara normalizado (sin tildes, sin mayúsculas), porque el `status` de
   * EA es texto libre y nadie garantiza cómo se escribió.
   */
  freeStatuses?: readonly string[];
};

/** Cancelada y no asistió liberan la silla. Ver `ConflictInput.freeStatuses`. */
export const DEFAULT_FREE_STATUSES = [
  "cancelled",
  "cancelada",
  "canceled",
  "no-show",
  "noshow",
  "no-asistio",
] as const;

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export type ConflictSeverity = "hard" | "soft";

export type ConflictReason =
  /** `end <= start`. No es un choque, es un dato que no puede existir. */
  | "invalid-window"
  /** La técnica ya está con otra clienta. */
  | "provider-busy"
  /** Se pasa el `attendantsNumber` del servicio. */
  | "service-capacity"
  /** Fuera de la ventana del plan semanal. */
  | "outside-working-plan"
  /** Fuera de la ventana que fijó una excepción de ese día. */
  | "plan-exception"
  /** Dentro de un descanso. */
  | "during-break"
  /** El estudio está cerrado. */
  | "blocked-period"
  /** La técnica marcó ese hueco como no disponible. */
  | "provider-unavailable"
  /** No queda puesto libre en el estudio. */
  | "no-station";

/** Con qué choca. Es lo que la UI enumera debajo del motivo. */
export type ConflictSubject =
  | {
      kind: "appointment";
      id: number;
      providerId: number | null;
      serviceId: number | null;
      status: string;
      start: EaLocalDateTime;
      end: EaLocalDateTime;
    }
  | {
      kind: "unavailability";
      id: number;
      providerId: number | null;
      notes: string | null;
      start: EaLocalDateTime;
      end: EaLocalDateTime;
    }
  | {
      kind: "blocked-period";
      id: number;
      name: string | null;
      start: EaLocalDateTime;
      end: EaLocalDateTime;
    }
  | {
      kind: "working-plan";
      date: EaLocalDate;
      source: "plan" | "plan-exception";
      exceptionId: number | null;
      /** `null` = día libre. */
      startMinute: number | null;
      endMinute: number | null;
    }
  | {
      kind: "station";
      /** Instante donde la cuenta no da. */
      at: EaLocalDateTime;
      /** Citas simultáneas contando el candidato. */
      needed: number;
      /** Cuántas de esas se pudieron sentar. */
      seated: number;
      total: number;
    };

export type Conflict = {
  reason: ConflictReason;
  severity: ConflictSeverity;
  /** Texto por defecto, en español. La UI puede reescribirlo. */
  message: string;
  /** El tramo exacto que choca, para resaltarlo en la grilla. */
  window: { start: EaLocalDateTime; end: EaLocalDateTime } | null;
  with: readonly ConflictSubject[];
};

export type ConflictReport = {
  /** No hay ningún motivo. */
  ok: boolean;
  /** Hay al menos un motivo `hard`. Cambia el tono del diálogo, no lo bloquea. */
  hard: boolean;
  /** Ordenados: primero los `hard`, después los `soft`. */
  conflicts: readonly Conflict[];
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

type Span = { start: EaLocalDateTime; end: EaLocalDateTime };

/**
 * Solape estricto, en hora de pared.
 *
 * Se comparan las cadenas porque `YYYY-MM-DD HH:mm:ss` ordena
 * lexicográficamente igual que cronológicamente dentro de una zona sin saltos
 * — la misma razón de `compareEaLocal` en A1, y más barato que construir
 * cuatro `Date` por comparación.
 */
export function overlaps(a: Span, b: Span): boolean {
  return compareEaLocal(a.start, b.end) < 0 && compareEaLocal(b.start, a.end) < 0;
}

/** Igual que `overlaps` pero para un instante puntual: `[start, end)`. */
function contains(span: Span, at: EaLocalDateTime): boolean {
  return compareEaLocal(span.start, at) <= 0 && compareEaLocal(at, span.end) < 0;
}

/**
 * Normaliza un `status` de EA para compararlo. Sin tildes, sin mayúsculas, con
 * guiones: `"No asistió"`, `"NO ASISTIO"` y `"no-asistio"` caen en el mismo lugar.
 *
 * Es un duplicado de tres líneas del normalizador de `components/ui/status.ts`,
 * y es deliberado: `lib/` no debe importar de `components/`. La alternativa es
 * un módulo compartido que hoy tendría una sola función.
 */
export function normalizeStatus(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function servicesOf(
  input: ConflictInput["services"],
): ReadonlyMap<number, ServiceCapacity> {
  if (!input) return new Map();
  if (input instanceof Map) return input;
  return new Map((input as readonly ServiceCapacity[]).map((s) => [s.id, s]));
}

function subjectOf(appointment: Appointment): ConflictSubject {
  return {
    kind: "appointment",
    id: appointment.id,
    providerId: appointment.providerId,
    serviceId: appointment.serviceId,
    status: appointment.status,
    start: appointment.start,
    end: appointment.end,
  };
}

const SEVERITY_ORDER: Record<ConflictSeverity, number> = { hard: 0, soft: 1 };

// ---------------------------------------------------------------------------
// Puestos
// ---------------------------------------------------------------------------

function fits(station: StationSlot, category: string | null): boolean {
  // Una categoría desconocida entra en cualquier puesto. Es la lectura
  // permisiva, la misma que eligió la siembra de `station` al dejar `allows` en
  // `NULL`: la restrictiva escondería citas que sí caben, y eso se paga con una
  // agenda que la recepción deja de creerle.
  if (station.allows === null || category === null) return true;
  return station.allows.includes(category);
}

/**
 * ¿Cuántas de estas citas se pueden sentar a la vez?
 *
 * Es un emparejamiento bipartito cita ↔ puesto: con puestos especializados no
 * alcanza con contar, porque dos citas de pies y un solo puesto de pies dan
 * "dos citas, dos puestos" y sin embargo una se queda parada. Camino de
 * aumento (algoritmo de Kuhn), que con dos puestos y un puñado de citas es
 * instantáneo y, a diferencia de contar, es exacto.
 */
export function seatCount(
  categories: readonly (string | null)[],
  stations: readonly StationSlot[],
): number {
  /** Índice de cita asignada a cada puesto, o `-1`. */
  const takenBy: number[] = stations.map(() => -1);
  let seated = 0;

  const trySeat = (item: number, visited: boolean[]): boolean => {
    for (let s = 0; s < stations.length; s += 1) {
      if (visited[s] || !fits(stations[s], categories[item])) continue;
      visited[s] = true;
      if (takenBy[s] === -1 || trySeat(takenBy[s], visited)) {
        takenBy[s] = item;
        return true;
      }
    }
    return false;
  };

  for (let item = 0; item < categories.length; item += 1) {
    if (trySeat(item, stations.map(() => false))) seated += 1;
  }

  return seated;
}

// ---------------------------------------------------------------------------
// checkConflicts
// ---------------------------------------------------------------------------

/**
 * Evalúa el candidato contra todo lo que puede impedirlo.
 *
 * Se re-evalúa **al enviar**, contra datos frescos, no solo al abrir el
 * formulario: que dos personas editen a la vez es el caso normal de esta
 * pantalla, no el raro.
 */
export function checkConflicts(input: ConflictInput): ConflictReport {
  const { candidate } = input;
  const conflicts: Conflict[] = [];

  // ── 0. El candidato tiene que ser un intervalo posible ───────────────────
  const order = compareEaLocal(candidate.start, candidate.end);

  if (order >= 0) {
    conflicts.push({
      reason: "invalid-window",
      severity: "hard",
      message:
        order === 0
          ? "La cita dura cero minutos."
          : "La cita termina antes de empezar.",
      window: { start: candidate.start, end: candidate.end },
      with: [],
    });

    // Sin un intervalo válido, todo lo demás daría respuestas sin sentido: un
    // solape estricto contra un intervalo vacío es siempre `false`, así que
    // seguir devolvería "no hay choques" — la peor respuesta posible.
    return finish(conflicts);
  }

  const window: Span = { start: candidate.start, end: candidate.end };
  const services = servicesOf(input.services);
  const free = new Set(
    (input.freeStatuses ?? DEFAULT_FREE_STATUSES).map((s) => normalizeStatus(s)),
  );

  /** Las citas que de verdad ocupan: ni la propia, ni las que ya se cayeron. */
  const occupying = (input.appointments ?? []).filter(
    (a) =>
      a.id !== candidate.id &&
      !free.has(normalizeStatus(a.status)),
  );

  // ── 1. La técnica ya está con otra clienta ───────────────────────────────
  //
  // EA permite `attendantsNumber > 1` para que una técnica atienda a varias a
  // la vez, y su `Availability::consider_multiple_attendants()` lo hace mirando
  // **la misma técnica y el mismo servicio**: una cita de otro servicio encima
  // bloquea siempre. El estudio, además, tiene la regla de que una técnica
  // atiende a una clienta a la vez (§ Multi-técnica).
  //
  // Las dos reglas se reconcilian sin inventar nada: se implementa la de EA
  // exacta, y como en la práctica todos los servicios tienen
  // `attendantsNumber` = 1, degenera **exactamente** en "una técnica, una
  // clienta". El día que la dueña ponga un servicio en 2 (dos clientas en
  // remojo a la vez), el motor no la veta.
  const sameProvider = occupying.filter(
    (a) => a.providerId === candidate.providerId && overlaps(window, a),
  );

  // ── 2. Capacidad del servicio ────────────────────────────────────────────
  const capacityRaw =
    candidate.serviceId === null
      ? null
      : (services.get(candidate.serviceId)?.attendantsNumber ?? null);
  const capacity = capacityRaw !== null && capacityRaw > 1 ? Math.trunc(capacityRaw) : 1;

  if (capacity === 1) {
    // El caso normal del estudio, y el único que existe hoy: cualquier solape
    // en la columna es choque duro.
    if (sameProvider.length > 0) {
      conflicts.push({
        reason: "provider-busy",
        severity: "hard",
        message:
          sameProvider.length === 1
            ? "La profesional ya tiene otra cita en ese horario."
            : `La profesional ya tiene ${sameProvider.length} citas en ese horario.`,
        window,
        with: sameProvider.map(subjectOf),
      });
    }
  } else {
    // Con `attendantsNumber > 1`, EA deja apilar clientas del **mismo**
    // servicio y sigue bloqueando cualquier cita de otro servicio encima
    // (`Availability::consider_multiple_attendants()` + los dos contadores de
    // `Appointments_model`). Se replica esa división exacta en dos motivos
    // distintos, para que el diálogo pueda decir cuál de las dos cosas pasó.
    const otherService = sameProvider.filter((a) => a.serviceId !== candidate.serviceId);
    const sameService = sameProvider.filter((a) => a.serviceId === candidate.serviceId);

    if (otherService.length > 0) {
      conflicts.push({
        reason: "provider-busy",
        severity: "hard",
        message:
          otherService.length === 1
            ? "La profesional ya tiene otra cita de otro servicio en ese horario."
            : `La profesional ya tiene ${otherService.length} citas de otros servicios en ese horario.`,
        window,
        with: otherService.map(subjectOf),
      });
    }

    if (sameService.length + 1 > capacity) {
      conflicts.push({
        reason: "service-capacity",
        severity: "hard",
        message: `El servicio admite ${capacity} clientas a la vez y ya hay ${sameService.length}.`,
        window,
        with: sameService.map(subjectOf),
      });
    }
  }

  // ── 3. Plan de trabajo, excepciones y descansos ──────────────────────────
  if (input.provider) {
    conflicts.push(...checkWorkingPlan(candidate, input.provider));
  }

  // ── 4. Bloqueos del estudio ──────────────────────────────────────────────
  const blocked = (input.blockedPeriods ?? []).filter((p) => overlaps(window, p));

  if (blocked.length > 0) {
    conflicts.push({
      reason: "blocked-period",
      severity: "soft",
      message:
        blocked[0].name !== null && blocked[0].name !== ""
          ? `El estudio está cerrado: ${blocked[0].name}.`
          : "El estudio está cerrado en ese horario.",
      window,
      with: blocked.map((p) => ({
        kind: "blocked-period" as const,
        id: p.id,
        name: p.name,
        start: p.start,
        end: p.end,
      })),
    });
  }

  // ── 5. Indisponibilidades de la técnica ──────────────────────────────────
  const unavailable = (input.unavailabilities ?? []).filter(
    (u) => u.providerId === candidate.providerId && overlaps(window, u),
  );

  if (unavailable.length > 0) {
    conflicts.push({
      reason: "provider-unavailable",
      severity: "soft",
      message: "La profesional marcó ese horario como no disponible.",
      window,
      with: unavailable.map((u) => ({
        kind: "unavailability" as const,
        id: u.id,
        providerId: u.providerId,
        notes: u.notes,
        start: u.start,
        end: u.end,
      })),
    });
  }

  // ── 6. Puestos libres a nivel de ESTUDIO ─────────────────────────────────
  if (input.stations) {
    const shortage = findStationShortage(candidate, occupying, input.stations, services);
    if (shortage) conflicts.push(shortage);
  }

  return finish(conflicts);
}

function finish(conflicts: Conflict[]): ConflictReport {
  const sorted = [...conflicts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return {
    ok: sorted.length === 0,
    hard: sorted.some((c) => c.severity === "hard"),
    conflicts: sorted,
  };
}

// ---------------------------------------------------------------------------
// Plan de trabajo
// ---------------------------------------------------------------------------

/**
 * ¿El candidato cabe dentro de la jornada de la técnica?
 *
 * Se evalúa **día por día**, y no por comodidad: una cita puede cruzar la
 * medianoche, y entonces el plan que la autoriza es el de dos días distintos.
 * El plan de cada día se resuelve con `resolveWorkingWindow()` de
 * `calendar-layout`, para que la grilla y el motor no puedan discrepar sobre
 * dónde termina la jornada.
 */
function checkWorkingPlan(
  candidate: ConflictCandidate,
  provider: Pick<GridProvider, "workingPlan" | "workingPlanExceptions">,
): Conflict[] {
  const startDate = parseEaLocalDate(candidate.start.slice(0, 10));
  const endDate = parseEaLocalDate(candidate.end.slice(0, 10));

  type Piece = {
    start: EaLocalDateTime;
    end: EaLocalDateTime;
    date: EaLocalDate;
    source: "plan" | "plan-exception";
    exceptionId: number | null;
    windowStart: number | null;
    windowEnd: number | null;
  };

  const outside: Piece[] = [];
  const inBreak: Piece[] = [];

  for (const date of datesBetween(startDate, endDate)) {
    const plan = resolveWorkingWindow(provider, date);

    const dayStart = `${date} 00:00:00` as EaLocalDateTime;
    const dayEnd = nextMidnight(date);

    // El tramo del candidato que cae en este día.
    const from = maxLocal(candidate.start, dayStart);
    const to = minLocal(candidate.end, dayEnd);
    if (compareEaLocal(from, to) >= 0) continue;

    const meta = {
      date,
      source: plan.window.source,
      exceptionId: plan.window.exceptionId,
      windowStart: plan.window.startMinute,
      windowEnd: plan.window.endMinute,
    };

    if (plan.window.startMinute === null || plan.window.endMinute === null) {
      outside.push({ start: from, end: to, ...meta });
      continue;
    }

    const workFrom = atMinute(date, plan.window.startMinute);
    const workTo = atMinute(date, plan.window.endMinute);

    if (compareEaLocal(from, workFrom) < 0) {
      outside.push({ start: from, end: minLocal(to, workFrom), ...meta });
    }
    if (compareEaLocal(to, workTo) > 0) {
      outside.push({ start: maxLocal(from, workTo), end: to, ...meta });
    }

    for (const brk of plan.breaks) {
      const brkFrom = atMinute(date, brk.startMinute);
      const brkTo = atMinute(date, brk.endMinute);
      if (!overlaps({ start: from, end: to }, { start: brkFrom, end: brkTo })) continue;
      inBreak.push({
        start: maxLocal(from, brkFrom),
        end: minLocal(to, brkTo),
        ...meta,
      });
    }
  }

  const out: Conflict[] = [];
  const asSubject = (piece: Piece): ConflictSubject => ({
    kind: "working-plan",
    date: piece.date,
    source: piece.source,
    exceptionId: piece.exceptionId,
    startMinute: piece.windowStart,
    endMinute: piece.windowEnd,
  });

  // Fuera del plan y fuera de una excepción son motivos distintos: "Lina no
  // trabaja los domingos" y "Lina ese jueves entra a las 11" piden mensajes
  // distintos, aunque geométricamente sean la misma franja.
  for (const source of ["plan", "plan-exception"] as const) {
    const pieces = outside.filter((p) => p.source === source);
    if (pieces.length === 0) continue;

    const dayOff = pieces.some((p) => p.windowStart === null);

    out.push({
      reason: source === "plan" ? "outside-working-plan" : "plan-exception",
      severity: "soft",
      message:
        source === "plan"
          ? dayOff
            ? "La profesional no trabaja ese día."
            : "La cita queda fuera del horario de la profesional."
          : dayOff
            ? "Ese día la profesional tiene el día libre por una excepción."
            : "La cita queda fuera del horario excepcional de ese día.",
      window: { start: pieces[0].start, end: pieces[pieces.length - 1].end },
      with: pieces.map(asSubject),
    });
  }

  if (inBreak.length > 0) {
    out.push({
      reason: "during-break",
      severity: "soft",
      message: "La cita cae dentro de un descanso de la profesional.",
      window: { start: inBreak[0].start, end: inBreak[inBreak.length - 1].end },
      with: inBreak.map(asSubject),
    });
  }

  return out;
}

/** Fechas de `from` a `till`, inclusive. Una cita no cruza más de dos días. */
function datesBetween(from: EaLocalDate, till: EaLocalDate): EaLocalDate[] {
  const out: EaLocalDate[] = [];
  let cursor = from;

  // El tope es una guarda contra una cita corrupta con fin en el año 3000: un
  // bucle que recorre un millón de días no falla, se cuelga, y colgarse es más
  // difícil de diagnosticar que equivocarse.
  for (let i = 0; i < 400 && cursor <= till; i += 1) {
    out.push(cursor);
    cursor = nextMidnight(cursor).slice(0, 10) as EaLocalDate;
  }

  return out;
}

/** Medianoche del día siguiente, por aritmética de calendario pura. */
function nextMidnight(date: EaLocalDate): EaLocalDateTime {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const iso = next.toISOString().slice(0, 10);
  return `${iso} 00:00:00` as EaLocalDateTime;
}

/**
 * Minuto del día → hora de pared.
 *
 * Los minutos del plan son **de reloj**, no de línea de tiempo: "de 9 a 6" es
 * 9:00 en el reloj de la pared pase lo que pase con el offset. Por eso se
 * construye la cadena en vez de sumar minutos a la medianoche, que en un salto
 * de horario daría una hora corrida. `24:00` del plan de EA se resuelve a la
 * medianoche siguiente, que es lo que significa.
 */
function atMinute(date: EaLocalDate, minute: number): EaLocalDateTime {
  if (minute >= 24 * 60) {
    const base = nextMidnight(date).slice(0, 10) as EaLocalDate;
    return atMinute(base, minute - 24 * 60);
  }
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `${date} ${hh}:${mm}:00` as EaLocalDateTime;
}

function minLocal(a: EaLocalDateTime, b: EaLocalDateTime): EaLocalDateTime {
  return compareEaLocal(a, b) <= 0 ? a : b;
}

function maxLocal(a: EaLocalDateTime, b: EaLocalDateTime): EaLocalDateTime {
  return compareEaLocal(a, b) >= 0 ? a : b;
}

// ---------------------------------------------------------------------------
// Puestos del estudio
// ---------------------------------------------------------------------------

/**
 * ¿Queda puesto para el candidato en toda su ventana?
 *
 * **EA no tiene ningún concepto de sala, puesto o equipo** —
 * `attendantsNumber` es capacidad por servicio, no por local. Con tres técnicas
 * en agenda, dos citas simultáneas pasan y tres no. Esta dimensión es
 * enteramente nuestra y es la más fácil de olvidar.
 *
 * Se evalúa solo en los **instantes de inicio** dentro de la ventana (el propio
 * inicio del candidato y el de cada cita que arranca durante ella): la
 * concurrencia solo puede subir cuando algo empieza, así que un máximo que no
 * aparezca en uno de esos puntos no existe. Barrer minuto a minuto daría el
 * mismo resultado y sería mil veces más caro.
 */
function findStationShortage(
  candidate: ConflictCandidate,
  occupying: readonly Appointment[],
  stations: readonly StationSlot[],
  services: ReadonlyMap<number, ServiceCapacity>,
): Conflict | null {
  const window: Span = { start: candidate.start, end: candidate.end };
  const concurrent = occupying.filter((a) => overlaps(window, a));

  const instants = [
    candidate.start,
    ...concurrent
      .map((a) => a.start)
      .filter((s) => compareEaLocal(s, candidate.start) > 0),
  ];

  const categoryOf = (serviceId: number | null): string | null =>
    serviceId === null ? null : (services.get(serviceId)?.category ?? null);

  for (const at of [...new Set(instants)].sort(compareEaLocal)) {
    const here = concurrent.filter((a) => contains(a, at));
    const categories = [
      categoryOf(candidate.serviceId),
      ...here.map((a) => categoryOf(a.serviceId)),
    ];

    const seated = seatCount(categories, stations);
    if (seated >= categories.length) continue;

    return {
      reason: "no-station",
      severity: "hard",
      message:
        stations.length === 0
          ? "No hay puestos configurados en el estudio."
          : `No queda puesto libre: ${categories.length} citas a la vez y ${stations.length} ${stations.length === 1 ? "puesto" : "puestos"}.`,
      window,
      with: [
        {
          kind: "station",
          at,
          needed: categories.length,
          seated,
          total: stations.length,
        },
        ...here.map(subjectOf),
      ],
    };
  }

  return null;
}
