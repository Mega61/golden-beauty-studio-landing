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
  providerName: string;
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

/**
 * Arma el aviso.
 *
 * `basePath` entra como parámetro (y no importado de la config de Next) para
 * que la función siga siendo pura; el llamador pasa `PANEL_BASE_PATH`.
 *
 * El enlace usa `?dia=`, que es el parámetro real de la agenda
 * (`app/(panel)/agenda/page.tsx` → `parseAnchor(params.dia)`): tocar el aviso
 * abre la agenda en el día de la cita, no en hoy.
 */
export function buildNewBookingPayload(
  notice: NewBookingNotice,
  today: string,
  basePath: string,
): PushPayload {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(notice.start);
  const date = m?.[1] ?? null;
  const when =
    m === null
      ? ""
      : `${relativeDayLabel(m[1], today)} ${formatHour12(Number(m[2]), Number(m[3]))}`;

  const service = clean(notice.serviceName ?? "", 60) || "servicio";
  const who = shortCustomerName(notice.customerFirstName, notice.customerLastName);
  const provider = clean(notice.providerName, 40);

  const parts = [who, when].filter(Boolean).join(" · ");
  const detail = provider ? `${parts} con ${provider}` : parts;

  const base = basePath.replace(/\/+$/, "");
  const agenda = `${base}/agenda`;

  // Dos renglones: qué se va a hacer, y quién y cuándo. Android e iOS respetan
  // el salto; `clean()` va por renglón porque se come los saltos de línea.
  const what = service.charAt(0).toLocaleUpperCase("es-CO") + service.slice(1);
  return {
    title: clean("Nueva reserva ✨", MAX_TITLE),
    body: `${what}\n${clean(detail, MAX_BODY - what.length - 1)}`,
    url: date === null ? agenda : `${agenda}?dia=${date}`,
    tag: `reserva-${notice.appointmentId}`,
    confirmUrl: `${base}/confirmar/${notice.appointmentId}`,
  };
}
