/**
 * Reglas puras para **leer** el historial de Agenda Pro (`legacy_appointment`)
 * en las pantallas que la dueña mira: la agenda de días pasados y los reportes.
 *
 * ## Por qué existe
 *
 * El importador dejó toda la historia en `gbs_admin.legacy_appointment`, pero
 * la agenda y casi todos los reportes leen solo EA + `appointment_finance`. La
 * dueña abrió el panel después del corte y vio la agenda vacía y los reportes
 * en cero: para ella "no se migró ni una cita". Este módulo es la traducción
 * común —quién atendió, cuánto duró, si ya está en EA, cómo terminó— que la
 * agenda y los reportes comparten, para que las dos pantallas no lleguen a
 * respuestas distintas sobre la misma fila.
 *
 * ## ⚠ Lo que este módulo NO es
 *
 * **No es un camino de plata.** Nada de acá alimenta `appointment_finance`, la
 * caja / cierre del día, el ingest a Strapi/Actual, las comisiones ni los
 * recordatorios. Esa plata ya está en Actual Budget, metida por el scraper de
 * Agenda Pro con `imported_id = agendapro-tx:<id>`; volver a empujarla la
 * duplicaría en silencio. `legacy-history.money-paths.test.ts` lo vigila
 * leyendo el código de esos caminos.
 */

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------

/**
 * `"  Semipermanente  MANOS "` → `"semipermanente manos"`, sin tildes.
 *
 * Agenda Pro y EA escriben los mismos servicios a mano, cada uno a su manera:
 * "Uñas acrílicas" vs. "unas acrilicas". La comparación es por esta forma.
 */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** El nombre de pila, normalizado. `null` si no hay ninguno. */
export function firstNameKey(value: string | null | undefined): string | null {
  const first = normalizeName(value).split(" ")[0] ?? "";
  return first === "" ? null : first;
}

/**
 * La profesional actual que corresponde a la que atendió en Agenda Pro.
 *
 * Agenda Pro no comparte ids con EA y el import guarda el nombre tal cual
 * ("Mariana"). La regla es **nombre de pila exacto y único**: si hay una sola
 * profesional en EA con ese nombre de pila, es ella. Si no hay ninguna (Kati ya
 * no trabaja en el estudio) o hay dos con el mismo nombre, se devuelve `null`
 * y la fila queda en el carril de solo lectura "Historial Agenda Pro": adivinar
 * entre dos Marianas sería atribuirle a una las citas de la otra.
 */
export function matchLegacyProvider(
  providerName: string | null | undefined,
  providers: readonly { id: number; firstName: string | null }[],
): number | null {
  const key = firstNameKey(providerName);
  if (key === null) return null;
  const matches = providers.filter((provider) => firstNameKey(provider.firstName) === key);
  return matches.length === 1 ? matches[0].id : null;
}

// ---------------------------------------------------------------------------
// Duración
// ---------------------------------------------------------------------------

/** Lo que se asume cuando no hay con qué derivar la duración. */
export const LEGACY_DEFAULT_MINUTES = 60;

/**
 * Cuánto dibujar una cita heredada, que no trae hora de fin.
 *
 * El export de Agenda Pro no trae `ended_at` (la columna existe y viene
 * `NULL`). Para poder pintar el bloque se toma la duración del servicio de EA
 * **con el mismo nombre** (sin mayúsculas ni tildes); si no hay ninguno, una
 * hora. `derived: false` lo marca para que el detalle diga que la duración es
 * supuesta: es un dibujo, no un dato, y no se usa para ninguna cuenta (por eso
 * la ocupación no lee el historial).
 */
export function legacyDurationMinutes(
  serviceName: string | null | undefined,
  services: readonly { name: string; duration: number | null }[],
): { minutes: number; derived: boolean } {
  const key = normalizeName(serviceName);
  if (key !== "") {
    const match = services.find((service) => normalizeName(service.name) === key);
    if (match && match.duration !== null && match.duration > 0) {
      return { minutes: match.duration, derived: true };
    }
  }
  return { minutes: LEGACY_DEFAULT_MINUTES, derived: false };
}

// ---------------------------------------------------------------------------
// Duplicados con EA
// ---------------------------------------------------------------------------

/**
 * Los últimos diez dígitos del teléfono: lo que un celular colombiano es con o
 * sin `+57`, con o sin espacios. EA y el import no garantizan el mismo formato.
 */
export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

/** La hora de pared hasta el minuto: `"2026-10-16 10:00"`. */
function minuteKey(start: string): string {
  return start.slice(0, 16);
}

/**
 * ¿Esta fila heredada ya existe como cita real de EA?
 *
 * Las reservas futuras de Agenda Pro se volvieron a crear en EA a mano el día
 * del corte, así que esas filas están dos veces. Es la misma cita si empieza en
 * el mismo minuto **y** es la misma persona: mismo teléfono, o —si alguna de
 * las dos no tiene teléfono— mismo nombre normalizado. Gana EA, porque es la
 * cita viva que se puede editar y cobrar.
 */
export function isShadowedByEa(
  legacy: { start: string; phone: string | null; clientName: string | null },
  ea: readonly { start: string; phone: string | null; customerName: string | null }[],
): boolean {
  const at = minuteKey(legacy.start);
  const phone = phoneKey(legacy.phone);
  const name = normalizeName(legacy.clientName);

  return ea.some((appointment) => {
    if (minuteKey(appointment.start) !== at) return false;
    const otherPhone = phoneKey(appointment.phone);
    if (phone !== null && otherPhone !== null) return phone === otherPhone;
    const otherName = normalizeName(appointment.customerName);
    return name !== "" && name === otherName;
  });
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/** Lo que se puede saber de una cita heredada, a partir de su texto libre. */
export type LegacyStatusKind = "atendida" | "no-asistio" | "cancelada";

/**
 * El estado de una fila de `legacy_appointment`, leído de su texto libre.
 *
 * El histórico de Agenda Pro guarda el estado como texto suyo, no el de EA, y
 * el export no trae una lista cerrada. Por eso la lectura es por **exclusión**:
 * es atendida la que no dice que se cayó. Descartar todo lo que no se
 * reconozca borraría la clientela heredada de los reportes, que es exactamente
 * lo que `legacy_appointment` existe para evitar.
 *
 * Vive acá, una sola vez, y `reportes/aggregate.ts` la reexporta: la usan la
 * unión EA + legacy de "clienta nueva", la demanda por día y hora, la
 * exportación para Meta, la agenda y las ventas. Una segunda expresión regular
 * en otro archivo es una segunda definición de "atendida" que tarde o temprano
 * se separa de la primera. (Se mudó desde `aggregate.ts` para que la agenda,
 * que es código de cliente, no tenga que importar todo el módulo de reportes.)
 */
export function legacyStatusKind(status: string | null | undefined): LegacyStatusKind {
  const text = status ?? "";
  if (/cancel/i.test(text)) return "cancelada";
  if (/no.?asis|no.?show/i.test(text)) return "no-asistio";
  return "atendida";
}

export type LegacyReportKind = LegacyStatusKind | "reservada";

/**
 * El estado de una fila heredada, para la agenda y los reportes de ventas e
 * inasistencia.
 *
 * Parte de `legacyStatusKind()` y solo le agrega una salida: lo que dice
 * **Reservado** (o confirmado, agendado, pendiente) todavía no había pasado el
 * día del export. Contarlo como atendido inflaría las citas atendidas con
 * reservas que eran futuro. Las demás pantallas siguen con la regla de siempre.
 */
export function legacyReportKind(status: string | null | undefined): LegacyReportKind {
  const kind = legacyStatusKind(status);
  if (kind !== "atendida") return kind;
  if (/reserv|confirm|agend|pendiente/i.test(status ?? "")) return "reservada";
  return "atendida";
}
