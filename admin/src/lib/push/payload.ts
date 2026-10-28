/**
 * El contenido del aviso de "nueva reserva", como función pura.
 *
 * Vive acá y no en el route handler porque es justo la parte que se puede
 * equivocar en silencio: un aviso que dice "mañana" de una cita de hoy, o que
 * se lleva el teléfono de la clienta a una pantalla de bloqueo. Pura, con el
 * "hoy" inyectado, se testea entera sin reloj ni red.
 *
 * ## Lo que NO lleva, a propósito
 *
 * - **El teléfono de la clienta.** El aviso se ve en la pantalla de bloqueo de
 *   un celular que puede estar sobre el mesón, y viaja cifrado pero por los
 *   servidores de Apple o Google. El tipo de entrada ni siquiera tiene dónde
 *   recibirlo, y el test le pasa uno de contrabando para verificar que no
 *   sale.
 * - **El apellido completo.** "Laura M." basta para reconocerla en la agenda y
 *   es menos de lo que queda expuesto a quien mire el celular ajeno.
 * - **Precio.** Mismo criterio que los recordatorios de WhatsApp: la reserva
 *   web cobra el regular y el descuento se hace al pagar; un número acá sería
 *   el primero en estar mal.
 */

import { formatHour12 } from "@/components/ui/format";

export type NewBookingNotice = {
  appointmentId: number;
  /** Nombre del servicio en EA. `null` si no se pudo leer: el aviso sale igual. */
  serviceName: string | null;
  customerFirstName: string;
  customerLastName: string;
  /** Hora local de EA, `"YYYY-MM-DD HH:MM:SS"`. */
  start: string;
  providerName: string | null;
};

export type PushPayload = {
  title: string;
  body: string;
  /** Ruta absoluta **con** el basePath: el service worker no conoce Next. */
  url: string;
  /** Una reserva, un aviso: si el mismo llega dos veces, el segundo reemplaza. */
  tag: string;
  /**
   * El botón "Escribirle por WhatsApp": la ruta del panel que resuelve el
   * teléfono del lado del servidor (`/confirmar/:id`). Nunca un `wa.me`: el
   * número no viaja en el aviso.
   */
  confirmUrl?: string;
};

/** Techo por campo. El cifrado de Web Push deja ~4 KB y la pantalla, menos. */
const MAX_TITLE = 80;
const MAX_BODY = 160;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/**
 * Texto de afuera, apto para una notificación: sin saltos ni caracteres de
 * control (un nombre con `\n` partiría el aviso en dos líneas que parecen dos
 * datos), espacios colapsados y recortado con elipsis.
 */
function clean(raw: string, max: number): string {
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** `"Laura María"`, `"Martínez"` → `"Laura M."`. Sin apellido, solo el nombre. */
export function shortCustomerName(first: string, last: string): string {
  const f = clean(first, 40);
  const initial = clean(last, 40).charAt(0).toLocaleUpperCase("es-CO");
  if (f === "") return initial === "" ? "Sin nombre" : `${initial}.`;
  return initial === "" ? f : `${f} ${initial}.`;
}

function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/**
 * `"hoy"`, `"mañana"`, o `"vie 17 oct"`.
 *
 * Relativo cuando cabe porque es lo que se lee de un vistazo en la pantalla de
 * bloqueo: "hoy 3 p. m." pide moverse ya; "vie 17 oct" puede esperar. La
 * aritmética es de calendario (`Date.UTC`), no de reloj, así que no depende de
 * la zona del proceso.
 */
export function relativeDayLabel(date: string, today: string): string {
  const d = dayNumber(date);
  const t = dayNumber(today);
  if (d === null || t === null) return date;
  if (d === t) return "hoy";
  if (d === t + 1) return "mañana";
  const [y, mo, da] = date.split("-").map(Number);
  const dow = WEEKDAYS[new Date(Date.UTC(y, mo - 1, da)).getUTCDay()];
  return `${dow} ${da} ${MONTHS[mo - 1]}`;
}

/** `"2026-10-17 15:30:00"` → `{ date, time }`, o `null` si no parsea. */
function splitStart(start: string, today: string): { date: string; day: string; hour: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(start);
  if (m === null) return null;
  return { date: m[1], day: relativeDayLabel(m[1], today), hour: formatHour12(Number(m[2]), Number(m[3])) };
}

/** `"mañana 10 a. m."`, o `""` si la hora no parsea. */
function whenLabel(start: string, today: string): string {
  const s = splitStart(start, today);
  return s === null ? "" : `${s.day} ${s.hour}`;
}

/**
 * `"jue 10 a. m. → vie 3 p. m."`, o `"hoy 10 a. m. → 3 p. m."` si no cambió
 * de día: lo que se lee primero es cuánto se movió, no la fecha dos veces.
 */
function moveLabel(from: string, to: string, today: string): string {
  const a = splitStart(from, today);
  const b = splitStart(to, today);
  if (a === null || b === null) return whenLabel(to, today);
  return a.date === b.date
    ? `${a.day} ${a.hour} → ${b.hour}`
    : `${a.day} ${a.hour} → ${b.day} ${b.hour}`;
}

/**
 * El enlace del aviso. `?dia=` es el parámetro real de la agenda
 * (`app/(panel)/agenda/page.tsx` → `parseAnchor(params.dia)`): tocar el aviso
 * abre la agenda en el día de la cita, no en hoy. `?cita=` además abre su
 * detalle; va solo cuando quien recibe el aviso puede verla.
 */
function agendaUrl(basePath: string, start: string, appointmentId: number | null): string {
  const agenda = `${basePath.replace(/\/+$/, "")}/agenda`;
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(start)?.[1];
  if (date === undefined) return agenda;
  return appointmentId === null ? `${agenda}?dia=${date}` : `${agenda}?dia=${date}&cita=${appointmentId}`;
}

/** `"Juan Daza"` → `"Juan"`: quién lo hizo, sin ocupar el renglón. */
function actorLabel(name: string | null | undefined): string {
  return clean(name ?? "", 40).split(" ")[0] ?? "";
}

/**
 * Dos renglones: qué se va a hacer, y quién y cuándo. Android e iOS respetan
 * el salto; `clean()` va por renglón porque se come los saltos de línea.
 */
function compose(input: {
  title: string;
  serviceName: string | null;
  detail: readonly string[];
  url: string;
  appointmentId: number;
  confirmUrl?: string;
}): PushPayload {
  const service = clean(input.serviceName ?? "", 60) || "servicio";
  const what = service.charAt(0).toLocaleUpperCase("es-CO") + service.slice(1);
  const detail = input.detail.filter(Boolean).join(" · ");
  return {
    title: clean(input.title, MAX_TITLE),
    body: `${what}\n${clean(detail, MAX_BODY - what.length - 1)}`,
    url: input.url,
    // Una cita, una etiqueta: el aviso nuevo de la misma cita reemplaza al
    // anterior en vez de apilarse ("Nueva cita", después "Cita movida").
    tag: `reserva-${input.appointmentId}`,
    ...(input.confirmUrl ? { confirmUrl: input.confirmUrl } : {}),
  };
}

function withProvider(text: string, provider: string | null | undefined): string {
  const p = clean(provider ?? "", 40);
  return p ? `${text} con ${p}` : text;
}

/**
 * Arma el aviso.
 *
 * `basePath` entra como parámetro (y no importado de la config de Next) para
 * que la función siga siendo pura; el llamador pasa `PANEL_BASE_PATH`.
 */
export function buildNewBookingPayload(
  notice: NewBookingNotice,
  today: string,
  basePath: string,
): PushPayload {
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  const base = basePath.replace(/\/+$/, "");
  return compose({
    title: "Nueva reserva ✨",
    serviceName: notice.serviceName,
    detail: [withProvider([who, whenLabel(notice.start, today)].filter(Boolean).join(" · "), notice.providerName)],
    url: agendaUrl(base, notice.start, notice.appointmentId),
    appointmentId: notice.appointmentId,
    confirmUrl: `${base}/confirmar/${notice.appointmentId}`,
  });
}

/**
 * "Nueva cita ✨": una cita creada **desde el panel**, para el resto del equipo
 * que ve la agenda de todas (`avisos:reservas-web`). Dice quién la agendó,
 * porque es lo que la distingue de una reserva de la página.
 *
 * No trae "Escribirle por WhatsApp": a quien la agendó el panel ya le ofreció
 * mandar la confirmación, y dos personas confirmando la misma cita es la
 * clienta recibiendo dos mensajes.
 */
export function buildPanelBookingPayload(
  notice: NewBookingNotice & { actorName: string | null },
  today: string,
  basePath: string,
): PushPayload {
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  const actor = actorLabel(notice.actorName);
  return compose({
    title: "Nueva cita ✨",
    serviceName: notice.serviceName,
    detail: [
      withProvider([who, whenLabel(notice.start, today)].filter(Boolean).join(" · "), notice.providerName),
      actor ? `por ${actor}` : "",
    ],
    url: agendaUrl(basePath, notice.start, notice.appointmentId),
    appointmentId: notice.appointmentId,
  });
}

/**
 * "Nueva cita en tu agenda": el aviso de la profesional, por una cita **de su
 * columna** (`avisos:mis-citas`).
 *
 * Mismas reglas que el de reserva web —sin teléfono, sin precio, apellido en
 * inicial— y dos diferencias:
 *
 * - **No dice con quién**: es ella.
 * - **No trae "Escribirle por WhatsApp"**: confirmarle a la clienta es del
 *   WhatsApp del estudio (`recordatorios:enviar`), no del celular de la
 *   técnica, que es a donde la clienta respondería.
 *
 * El `tag` es el mismo que el del aviso general (`reserva-<id>`): si la dueña
 * atiende y recibe los dos en el mismo celular, el segundo reemplaza al
 * primero en vez de sumarse.
 */
export function buildOwnBookingPayload(
  notice: Omit<NewBookingNotice, "providerName">,
  today: string,
  basePath: string,
): PushPayload {
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  return compose({
    title: "Nueva cita en tu agenda ✨",
    serviceName: notice.serviceName,
    detail: [who, whenLabel(notice.start, today)],
    url: agendaUrl(basePath, notice.start, notice.appointmentId),
    appointmentId: notice.appointmentId,
  });
}

// ---------------------------------------------------------------------------
// Cambios y cancelaciones
// ---------------------------------------------------------------------------

/** Lo de una cita que, si cambia, alguien tiene que enterarse. */
export type AppointmentState = {
  start: string;
  end: string;
  providerId: number | null;
  serviceId: number | null;
  customerId: number | null;
  /** Los adicionales de la misma cita (migración `028`). */
  extraServiceIds: readonly number[];
  /**
   * Está cancelada. No entra a `diffAppointment`: pasar a cancelada desde el
   * formulario de edición es una cancelación y lleva su propio aviso.
   */
  cancelled: boolean;
};

export type AppointmentChange = {
  /** Cambió la hora de inicio (o el día). */
  moved: boolean;
  /** Cambió la columna. */
  reassigned: boolean;
  /** Cambió el servicio, los adicionales, la duración o la clienta. */
  edited: boolean;
};

/**
 * Qué cambió entre dos estados de la misma cita, o `null` si nada que valga un
 * aviso: las notas y el estado no lo valen (el estado lo cambia "Llegó", y
 * cancelar tiene su propio aviso).
 *
 * `before = null` es "no se pudo leer cómo estaba": se avisa igual, como
 * cambio genérico. Callar un cambio por no saber describirlo es peor.
 */
export function diffAppointment(
  before: AppointmentState | null,
  after: AppointmentState,
): AppointmentChange | null {
  if (before === null) return { moved: false, reassigned: false, edited: true };
  const extras = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).join(",");
  const change: AppointmentChange = {
    moved: before.start !== after.start,
    reassigned: before.providerId !== after.providerId,
    edited:
      before.end !== after.end ||
      before.serviceId !== after.serviceId ||
      before.customerId !== after.customerId ||
      extras(before.extraServiceIds) !== extras(after.extraServiceIds),
  };
  return change.moved || change.reassigned || change.edited ? change : null;
}

export type ChangeNotice = Omit<NewBookingNotice, "providerName"> & {
  /** La técnica de la cita **ahora**. */
  providerName: string | null;
  /** La de antes, si cambió de columna. */
  previousProviderName: string | null;
  /** El inicio de antes; `null` si no se pudo leer. */
  previousStart: string | null;
  actorName: string | null;
};

/**
 * El aviso de un cambio, según a quién le llega:
 *
 * - **`team`** (dueña y recepción): título por lo que pasó, la hora de antes
 *   y la de ahora, con quién (y con quién estaba), y quién lo hizo.
 * - **`own`** (la técnica de la columna): si la cita le llegó de otra columna,
 *   para ella es una cita nueva; si no, "Tu cita se movió" con las dos horas.
 * - **`left`** (la técnica de la que salió): que ya no la tiene. No dice a
 *   quién pasó ni enlaza la cita, que ya no es de su columna y no la puede ver.
 */
export function buildChangePayload(
  audience: "team" | "own" | "left",
  change: AppointmentChange,
  notice: ChangeNotice,
  today: string,
  basePath: string,
): PushPayload {
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  const time =
    change.moved && notice.previousStart !== null
      ? moveLabel(notice.previousStart, notice.start, today)
      : whenLabel(notice.start, today);

  if (audience === "left") {
    const start = notice.previousStart ?? notice.start;
    return compose({
      title: "Una cita salió de tu agenda",
      serviceName: notice.serviceName,
      detail: [who, whenLabel(start, today)],
      url: agendaUrl(basePath, start, null),
      appointmentId: notice.appointmentId,
    });
  }

  if (audience === "own") {
    if (change.reassigned) return buildOwnBookingPayload(notice, today, basePath);
    return compose({
      title: change.moved ? "Se movió una cita tuya" : "Cambió una cita tuya",
      serviceName: notice.serviceName,
      detail: [who, time],
      url: agendaUrl(basePath, notice.start, notice.appointmentId),
      appointmentId: notice.appointmentId,
    });
  }

  const provider = clean(notice.providerName ?? "", 40);
  const previous = clean(notice.previousProviderName ?? "", 40);
  const withWhom =
    change.reassigned && provider && previous
      ? `ahora con ${provider} (antes ${previous})`
      : provider
        ? `con ${provider}`
        : "";
  const actor = actorLabel(notice.actorName);
  return compose({
    title: change.moved ? "Cita movida" : change.reassigned ? "Cita reasignada" : "Cita modificada",
    serviceName: notice.serviceName,
    detail: [who, time, withWhom, actor ? `por ${actor}` : ""],
    url: agendaUrl(basePath, notice.start, notice.appointmentId),
    appointmentId: notice.appointmentId,
  });
}

/**
 * "Cita cancelada": a dueña y recepción (con quién era y quién la canceló) y a
 * la técnica de la columna.
 */
export function buildCancelPayload(
  audience: "team" | "own",
  notice: NewBookingNotice & { actorName: string | null },
  today: string,
  basePath: string,
): PushPayload {
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  const when = whenLabel(notice.start, today);
  const actor = actorLabel(notice.actorName);
  return compose({
    title: audience === "team" ? "Cita cancelada" : "Se canceló una cita tuya",
    serviceName: notice.serviceName,
    detail:
      audience === "team"
        ? [withProvider([who, when].filter(Boolean).join(" · "), notice.providerName), actor ? `por ${actor}` : ""]
        : [who, when],
    url: agendaUrl(basePath, notice.start, notice.appointmentId),
    appointmentId: notice.appointmentId,
  });
}
