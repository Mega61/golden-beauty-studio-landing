/**
 * El recordatorio por WhatsApp que manda una persona, con `wa.me`.
 *
 * Es el paliativo que nombra el corte (X7): el envío automático por la Cloud
 * API está trabado en la verificación de negocio y las plantillas de Meta, y
 * Agenda Pro —que hoy manda los recordatorios— está por cancelarse. Sin esto,
 * el día que se cancele las clientas dejan de recibir aviso **sin que nadie se
 * entere**. Con esto es trabajo humano diario, pero nadie se queda sin aviso.
 *
 * ## Por qué por día y no por ventana
 *
 * `jobs/reminders.ts` decide con una ventana estrecha alrededor de "24 h
 * antes" porque lo corre un cron cada media hora. Una persona no trabaja así:
 * abre el panel una vez en la mañana y otra al mediodía, y lo que necesita ver
 * es **las citas de mañana** (el aviso que da tiempo de reprogramar) y **las
 * que faltan hoy** (el del olvido del mismo día). La ventana estrecha le
 * escondería a recepción casi todas las citas casi todo el tiempo.
 *
 * Lo que sí se comparte con el job, para que los dos caminos estén de acuerdo:
 * los estados de EA que llevan aviso (`isSendableStatus`), el respeto a la
 * baja, el "sin teléfono", y el mismo `kind` en `wa_message` — que es lo que
 * hace que la `UNIQUE (cita, tipo)` cruce los dos canales y el emisor
 * automático no repita un aviso que recepción ya mandó.
 *
 * Todo lo de este archivo es puro: entra la data, sale la decisión o el texto.
 */

import { formatDateLong, parseWallClock } from "@/components/ui/format";
import type { WaMessageChannel, WaMessageKind, WaMessageStatus } from "@/db/types";
import { isSendableStatus } from "@/jobs/reminders";
import { eaDatePart, eaLocalToInstant, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";

/**
 * La "plantilla" de una fila manual. Versionada: si el texto cambia, sube.
 *
 * `v2`: el texto con emojis y el día y la hora en renglones propios. Las filas
 * viejas siguen diciendo `v1`, que es lo que de verdad se mandó entonces.
 * `v3` (2026-10-24): la confirmación dice "agendada" y el recordatorio le pide
 * a la clienta que responda SÍ, para tener en el chat que va a venir.
 */
export const MANUAL_TEMPLATE = "manual-wa-me-v3";

/** La dirección que va en el mensaje. Una sola, escrita una sola vez. */
export const STUDIO_ADDRESS = "Calle 69 Sur #43a - 41, primer piso, Sabaneta";

export type ManualReminderDay = "hoy" | "manana";

/** Una cita, con lo que hace falta para decidir y para escribir el mensaje. */
export type ManualReminderAppointment = {
  eaAppointmentId: number;
  /** Hora de pared de EA, sin zona. */
  start: EaLocalDateTime;
  /** El `status` crudo de EA. */
  status: string;
  /** Ya normalizado a E.164. `null` = sin teléfono utilizable. */
  phoneE164: string | null;
  customerFirstName: string | null;
  /** Nombre completo, para la pantalla. */
  customerName: string;
  serviceName: string | null;
};

/** Lo que ya hay en `wa_message` para una cita y un tipo. */
export type ExistingReminder = {
  eaAppointmentId: number;
  kind: WaMessageKind;
  status: WaMessageStatus;
  channel: WaMessageChannel;
  sentAt: Date | null;
  /** Nombre de quien lo mandó a mano. `null` en `cloud_api`. */
  sentByName: string | null;
};

/**
 * En qué está el recordatorio de una cita.
 *
 * - `pendiente` — hay que mandarlo; tiene botón de envío.
 * - `fallo-automatico` — el emisor automático lo intentó y Meta no lo mandó
 *   (`fallido`). También tiene botón: recepción lo manda a mano **sobre la
 *   misma fila** (la `UNIQUE` no admite otra), que pasa a `manual`.
 * - `recordada` — ya hay una fila que dice que salió (a mano o por la API).
 * - `no-enviada` — hay fila, pero dice que **no** salió y no es un fallo que
 *   se pueda retomar (`omitido`). Se muestra en vez de esconderse.
 * - `sin-telefono`, `opt-out`, `estado-no-aplica` — los mismos motivos de
 *   `jobs/reminders.ts`.
 */
export type ManualReminderState =
  | "pendiente"
  | "fallo-automatico"
  | "recordada"
  | "no-enviada"
  | "sin-telefono"
  | "opt-out"
  | "estado-no-aplica";

export type ManualReminderRow = {
  appointment: ManualReminderAppointment;
  day: ManualReminderDay;
  kind: WaMessageKind;
  state: ManualReminderState;
  existing: ExistingReminder | null;
};

/** El tipo de `wa_message` que le toca a cada día. */
export const KIND_FOR_DAY: Record<ManualReminderDay, WaMessageKind> = {
  hoy: "recordatorio_2h",
  manana: "recordatorio_24h",
};

/** Una fila que dice que el mensaje salió. `pendiente` cuenta: es "tomada". */
const SENT_STATUSES: ReadonlySet<WaMessageStatus> = new Set([
  "pendiente",
  "enviado",
  "entregado",
  "leido",
]);

/**
 * A qué día de recordatorio pertenece una cita, o `null` si a ninguno.
 *
 * Las de hoy entran **solo si todavía no empezaron**: llegar tarde con el
 * aviso sirve, llegar después de la cita es ruido — la misma regla del job.
 * Pasado mañana no entra: ese aviso es de mañana.
 */
export function reminderDayOf(
  start: EaLocalDateTime,
  now: Date,
  today: EaLocalDate,
  tomorrow: EaLocalDate,
): ManualReminderDay | null {
  const date = eaDatePart(start);
  if (date === tomorrow) return "manana";
  if (date === today) {
    return eaLocalToInstant(start).getTime() > now.getTime() ? "hoy" : null;
  }
  return null;
}

/**
 * La lista de recordatorios del día, con su estado.
 *
 * El orden de las preguntas importa y es el del job: lo que **ya pasó**
 * (`existing`) va primero, porque es un hecho y no una decisión — una clienta
 * que se dio de baja después de recibir el aviso sigue habiéndolo recibido.
 * Después, estado de la cita, teléfono y baja.
 *
 * Hoy va antes que mañana: es lo más urgente, y en una pantalla de celular lo
 * primero es lo que se hace.
 */
export function planManualReminders(input: {
  appointments: readonly ManualReminderAppointment[];
  existing: readonly ExistingReminder[];
  optedOut: ReadonlySet<string>;
  now: Date;
  today: EaLocalDate;
  tomorrow: EaLocalDate;
}): ManualReminderRow[] {
  const byKey = new Map(
    input.existing.map((row) => [`${row.eaAppointmentId}:${row.kind}`, row]),
  );

  const rows: ManualReminderRow[] = [];

  for (const appointment of input.appointments) {
    const day = reminderDayOf(appointment.start, input.now, input.today, input.tomorrow);
    if (day === null) continue;

    const kind = KIND_FOR_DAY[day];
    const existing = byKey.get(`${appointment.eaAppointmentId}:${kind}`) ?? null;

    // Un fallo del automático no es un hecho consumado como un envío: la
    // clienta no recibió nada. Pasa por las mismas preguntas que una cita sin
    // fila, y si todas dan, se ofrece mandarlo a mano.
    const autoFailed =
      existing !== null && existing.channel === "cloud_api" && existing.status === "fallido";

    let state: ManualReminderState;
    if (existing !== null && !autoFailed) {
      state = SENT_STATUSES.has(existing.status) ? "recordada" : "no-enviada";
    } else if (!isSendableStatus(appointment.status)) {
      state = "estado-no-aplica";
    } else if (appointment.phoneE164 === null) {
      state = "sin-telefono";
    } else if (input.optedOut.has(appointment.phoneE164)) {
      state = "opt-out";
    } else {
      state = autoFailed ? "fallo-automatico" : "pendiente";
    }

    rows.push({ appointment, day, kind, state, existing });
  }

  const dayOrder: Record<ManualReminderDay, number> = { hoy: 0, manana: 1 };
  return rows.sort(
    (a, b) =>
      dayOrder[a.day] - dayOrder[b.day] ||
      a.appointment.start.localeCompare(b.appointment.start) ||
      a.appointment.eaAppointmentId - b.appointment.eaAppointmentId,
  );
}

// ── El texto ────────────────────────────────────────────────────────────────

/**
 * El primer nombre, presentable.
 *
 * Las fichas importadas de Agenda Pro vienen a veces en mayúsculas sostenidas
 * ("LAURA MARCELA") o en minúsculas: "Hola, LAURA" se lee como un grito y
 * delata que el mensaje lo armó una máquina. Si viene con mayúsculas y
 * minúsculas mezcladas, se respeta tal cual — "MaríaJosé" o "De la Cruz"
 * son decisiones de quien la escribió.
 */
export function presentableFirstName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (first === "") return null;

  const uniform = first === first.toUpperCase() || first === first.toLowerCase();
  if (!uniform) return first;

  return first
    .toLowerCase()
    .replace(/(^|[-'])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/**
 * `"2026-10-16 10:00:00"` → `"10:00 a. m."`. La hora sola, para el renglón 🕒.
 *
 * Siempre con minutos (`10:00` y no `10`): en un mensaje que la clienta lee
 * suelto, "10 a. m." se parece demasiado a un número cualquiera.
 */
export function clockTime(start: EaLocalDateTime): string {
  const wall = parseWallClock(start);
  if (wall === null) return "";
  const h12 = wall.hh % 12 === 0 ? 12 : wall.hh % 12;
  const meridiem = wall.hh < 12 ? "a. m." : "p. m.";
  return `${h12}:${String(wall.mm).padStart(2, "0")} ${meridiem}`;
}

/**
 * `"2026-10-16 10:00:00"` → `"a las 10:00 a. m."`; la una es `"a la 1:00 p. m."`.
 *
 * Es la hora dentro de una frase, la que usan las plantillas de Meta. El "a
 * la" de la una no es un detalle: "a las 1" es el error que delata a una
 * plantilla.
 */
export function spokenTime(start: EaLocalDateTime): string {
  const clock = clockTime(start);
  if (clock === "") return "";
  const article = clock.startsWith("1:") ? "a la" : "a las";
  return `${article} ${clock}`;
}

/** `"viernes 16 de octubre"` → `"Viernes 16 de octubre"`, para abrir un renglón. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * El cuerpo común a los dos mensajes: qué, cuándo, dónde, y cómo cambiarla.
 *
 * **Un dato por renglón, con su emoji adelante.** La clienta lo lee en la
 * vista previa de la notificación o de un vistazo antes de salir: el día y la
 * hora tienen que encontrarse sin leer la frase entera. Por eso van solos y
 * no metidos en una oración, y por eso son pocos emojis —uno por renglón y el
 * saludo—: más que eso se lee como publicidad, y esto es un aviso.
 *
 * **Nunca lleva precio**: el precio de la reserva no es necesariamente el que
 * se cobra (adicionales, promos que se aplican al pagar), y un número en el
 * mensaje es un número que la clienta va a reclamar en caja.
 */
/** El cierre de la confirmación: solo cómo cambiarla. */
const CLOSING_BOOKED = "Si necesitas cambiarla, respóndenos por aquí. ¡Te esperamos! 🤍";

/**
 * El cierre del recordatorio: **pide una respuesta**. Un "SÍ" en el chat es la
 * confirmación de asistencia que el estudio no tiene de otra forma, y una
 * pregunta directa se contesta mucho más que un "si necesitas cambiarla".
 */
const CLOSING_ASK_CONFIRM =
  "¿Nos confirmas tu asistencia? Responde *SÍ* para confirmar, o escríbenos si necesitas cambiarla. 🤍";

function composeMessage(input: {
  customerFirstName: string | null;
  headline: string;
  dateLine: string;
  start: EaLocalDateTime;
  closing: string;
}): string {
  const name = presentableFirstName(input.customerFirstName);
  const greeting = name === null ? "¡Hola! ✨" : `¡Hola, ${name}! ✨`;

  return [
    greeting,
    "",
    `${input.headline} 💅`,
    `📅 ${input.dateLine}`,
    `🕒 ${clockTime(input.start)}`,
    `📍 Golden Beauty Studio — ${STUDIO_ADDRESS}`,
    "",
    input.closing,
  ].join("\n");
}

/** `" de Semipermanente manos"`, o nada si la cita no tiene servicio. */
function serviceSuffix(serviceName: string | null): string {
  return serviceName?.trim() ? ` de ${serviceName.trim()}` : "";
}

/**
 * El recordatorio.
 *
 * **El día va siempre con su fecha, también hoy** ("Hoy, viernes 16 de
 * octubre"). El mensaje se lee horas después de mandado, a veces pasada la
 * medianoche, y "mañana" o "hoy" a secas dejan de ser ciertos; la fecha es lo
 * que la clienta puede comprobar sin preguntar.
 */
export function buildReminderText(input: {
  customerFirstName: string | null;
  serviceName: string | null;
  start: EaLocalDateTime;
  day: ManualReminderDay;
}): string {
  const relative = input.day === "hoy" ? "Hoy" : "Mañana";
  return composeMessage({
    customerFirstName: input.customerFirstName,
    headline: `Te recordamos tu cita${serviceSuffix(input.serviceName)}`,
    dateLine: `${relative}, ${formatDateLong(input.start)}`,
    start: input.start,
    closing: CLOSING_ASK_CONFIRM,
  });
}

/**
 * El mensaje de confirmación de una reserva recién hecha en la página.
 *
 * Lo manda la dueña o recepción con un toque desde el aviso del celular
 * ("Escribirle por WhatsApp"): la clienta recibe la confirmación por el chat
 * del estudio, que es por donde va a escribir si necesita cambiarla. Mismas
 * reglas y misma forma que el recordatorio, para que los dos se reconozcan
 * como del mismo estudio.
 */
export function buildConfirmationText(input: {
  customerFirstName: string | null;
  serviceName: string | null;
  start: EaLocalDateTime;
}): string {
  return composeMessage({
    customerFirstName: input.customerFirstName,
    headline: `Tu cita${serviceSuffix(input.serviceName)} quedó agendada`,
    dateLine: capitalize(formatDateLong(input.start)),
    start: input.start,
    closing: CLOSING_BOOKED,
  });
}

// ── El enlace ───────────────────────────────────────────────────────────────

/**
 * E.164: `+`, un dígito que no es cero, y de 7 a 14 más.
 *
 * Se valida de nuevo acá aunque el número venga normalizado: `wa.me` con un
 * número mal formado no falla, abre WhatsApp en "este número no está en
 * WhatsApp" — y para entonces la fila ya dice `enviado`.
 */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * `https://api.whatsapp.com/send?phone=573001234567&text=…`, o `null` si el
 * número no es E.164.
 *
 * **No `wa.me`**: cuando el enlace se abre en el navegador en vez de saltar
 * directo a la app, la redirección de `wa.me` cambia cada emoji del mensaje
 * por "�" (verificado 2026-10-16, móvil y escritorio). `api.whatsapp.com/send`
 * los conserva y en el celular abre la app igual.
 *
 * Los dígitos van **sin** el `+`, y el texto codificado entero: el `#` sin
 * codificar cortaría el mensaje ahí, porque el navegador lo toma como el
 * inicio del fragmento.
 */
export function waMeLink(phoneE164: string, text: string): string | null {
  if (!E164_RE.test(phoneE164)) return null;
  return `https://api.whatsapp.com/send?phone=${phoneE164.slice(1)}&text=${encodeURIComponent(text)}`;
}
