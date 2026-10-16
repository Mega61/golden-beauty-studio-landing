/**
 * Los enlaces de un teléfono de clienta: WhatsApp, llamada y cómo se pinta.
 *
 * Recepción trabaja por WhatsApp: confirmar, mover una cita, avisar que la
 * técnica se atrasó. Antes solo Recordatorios abría el chat, y en el resto del
 * panel había que copiar el número a mano, con el riesgo de copiar mal un
 * dígito y escribirle a otra persona. Por eso cada vista que muestra a una
 * clienta trae el enlace, y todos salen de acá.
 *
 * **El número se normaliza siempre antes de armar un enlace.** Lo que guarda
 * EA es lo que alguien tecleó (`"300 123 4567"`, `"(300)1234567"`), y un
 * `wa.me` o un `tel:` armado con eso abre "este número no está en WhatsApp" o
 * llama sin indicativo. Si no se puede normalizar, no hay enlace: se muestra el
 * texto tal cual, que es honesto, en vez de un botón que lleva a otra parte.
 *
 * Todo es puro y no toca la red: lo usa un componente que se pinta igual en un
 * Server Component que en uno cliente.
 */

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { presentableFirstName, waMeLink } from "@/lib/whatsapp/manual-reminder";

import { formatPhoneCO } from "./format";

export type PhoneLinks = {
  /** `"+573001234567"`. */
  e164: string;
  /** `"+57 300 123 4567"`, para la pantalla. */
  display: string;
  /** `https://wa.me/573001234567?text=…`, con el saludo ya escrito. */
  whatsapp: string;
  /** `tel:+573001234567`: con indicativo, para que marque igual desde cualquier celular. */
  tel: string;
};

/**
 * El saludo con que se abre el chat: `"¡Hola, Laura! ✨"`.
 *
 * Solo el saludo, a propósito. Quien abre el chat desde la agenda o la ficha
 * no siempre escribe por la cita (puede ser para mover otra, o devolver una
 * llamada), y un mensaje entero prellenado se manda sin leer. El saludo ahorra
 * el gesto y deja el resto a quien escribe. Mismo nombre presentable que los
 * recordatorios: "¡Hola, LAURA!" se lee como un grito.
 */
export function chatGreeting(customerName: string | null | undefined): string {
  const name = presentableFirstName(customerName);
  return name === null ? "¡Hola! ✨" : `¡Hola, ${name}! ✨`;
}

/**
 * Teléfono crudo → sus enlaces, o `null` si no se puede normalizar.
 *
 * `null` también para vacío: la vista decide qué decir cuando no hay número
 * ("Sin teléfono"), porque cada una lo dice distinto.
 */
export function phoneLinks(
  rawPhone: string | null | undefined,
  customerName?: string | null,
): PhoneLinks | null {
  const e164 = normalizePhoneE164(rawPhone);
  if (e164 === null) return null;
  const whatsapp = waMeLink(e164, chatGreeting(customerName));
  if (whatsapp === null) return null;
  return { e164, display: formatPhoneCO(e164), whatsapp, tel: `tel:${e164}` };
}
