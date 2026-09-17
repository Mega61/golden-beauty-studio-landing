import "server-only";

import {
  normalizePhoneE164,
  phoneSearchVariants,
  type E164,
} from "@/app/(panel)/clientes/identity";
import { createEaClient, type EaClient } from "@/lib/ea/client";
import type { EaLocalDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
import { pickProvider } from "@/lib/public-availability";
import type { Customer } from "@/lib/ea/types";
import { loadAvailability } from "../availability/data";

/**
 * Confirmar una reserva pública.
 *
 * ## Se vuelve a mirar la disponibilidad, siempre
 *
 * Entre que la clienta vio los horarios y tocó "confirmar" pasan minutos, y en
 * esos minutos la recepción pudo agendar a alguien en esa misma silla. Por eso
 * el hueco se re-verifica acá contra datos frescos, con el **mismo** camino que
 * lo ofreció (`loadAvailability`), en vez de confiar en lo que el navegador
 * mandó. Que dos personas escriban a la vez es el caso normal, no el raro.
 *
 * ## La identidad es el teléfono
 *
 * Se busca por E.164 antes de crear, y **nunca se inventa un correo**: uno
 * falso viaja como *attendee* del evento de Google, rebota, y ensucia la ficha
 * para siempre. Campo vacío es más honesto. Lo hace el módulo de C4, que ya
 * resuelve las variantes con las que EA guardó el número.
 */

export type BookingRequest = {
  serviceId: number;
  date: EaLocalDate;
  /** `"HH:MM"`, tal como vino del listado de horarios. */
  time: string;
  /** `null` = "cualquiera": la elige el panel. */
  providerId: number | null;
  firstName: string;
  lastName: string;
  phone: string;
  notes?: string | null;
};

export type BookingResult =
  | {
      status: "ok";
      appointmentId: number;
      /** A quién le tocó. La confirmación la nombra. */
      providerId: number;
      providerName: string;
      start: string;
      end: string;
    }
  /** El hueco existía cuando se listó y ya no. Es carrera, no error. */
  | { status: "taken" }
  | { status: "invalid-phone" }
  | { status: "unknown-service" };

export async function createBooking(
  input: BookingRequest,
  client: EaClient = createEaClient(),
): Promise<BookingResult> {
  const phone = normalizePhoneE164(input.phone);
  // Un número a medias deduplica mal, que es peor que no deduplicar.
  if (phone === null) return { status: "invalid-phone" };

  // Se pide sin filtrar por técnica aunque la clienta haya elegido una: hace
  // falta la lista completa de quiénes pueden tomar el hueco para resolver
  // "cualquiera", y el filtro se aplica después.
  const availability = await loadAvailability(
    { serviceId: input.serviceId, date: input.date },
    client,
  );

  if (availability.status === "unknown-service" || availability.status === "unbookable-service") {
    return { status: "unknown-service" };
  }
  if (availability.status === "no-providers") return { status: "taken" };

  const slot = availability.slots.find((s) => s.time === input.time);
  if (!slot) return { status: "taken" };

  const candidates =
    input.providerId === null
      ? slot.providerIds
      : slot.providerIds.filter((id) => id === input.providerId);

  // La técnica que pidió ya no está libre a esa hora, o nadie lo está.
  if (candidates.length === 0) return { status: "taken" };

  const dayAppointments = await client.appointments.list({
    from: input.date,
    till: input.date,
  });

  const providerId = pickProvider(candidates, dayAppointments);
  if (providerId === null) return { status: "taken" };

  const customer = await resolveCustomer(client, phone, input);

  const appointment = await client.appointments.create({
    start: slot.start,
    end: slot.end,
    customerId: customer.id,
    providerId,
    serviceId: input.serviceId,
    status: "Reservada",
    notes: input.notes?.trim() || null,
  });

  const provider = await client.providers.get(providerId);

  return {
    status: "ok",
    appointmentId: appointment.id,
    providerId,
    providerName: fullName(provider.firstName, provider.lastName) ?? `Profesional ${providerId}`,
    start: slot.start,
    end: slot.end,
  };
}

/**
 * La clienta de siempre, o una nueva.
 *
 * El `q=` de EA hace `LIKE` y trae de más — "300 123 4567" también encuentra a
 * quien tenga eso en las notas — así que el filtro de verdad es volver a
 * normalizar y comparar. Si hay varias filas con el mismo teléfono (EA no
 * deduplica y nunca lo va a hacer), se toma la de id más bajo: la más vieja es
 * la que tiene el historial.
 */
async function resolveCustomer(
  client: EaClient,
  phone: E164,
  input: BookingRequest,
): Promise<Customer> {
  const found = new Map<number, Customer>();

  for (const variant of phoneSearchVariants(phone)) {
    let page: Customer[];
    try {
      page = await client.customers.list({ q: variant });
    } catch (error) {
      // Una variante que EA rechaza no puede tumbar la reserva entera.
      if (error instanceof EaApiError && !error.isTransient) continue;
      throw error;
    }
    for (const customer of page) {
      if (normalizePhoneE164(customer.phone) === phone) found.set(customer.id, customer);
    }
  }

  const existing = [...found.values()].sort((a, b) => a.id - b.id)[0];
  if (existing) return existing;

  // Sin `email`: ver el encabezado. EA lo acepta porque `require_email` está en
  // false, que es parte de la configuración obligatoria del entorno.
  return client.customers.create({
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    phone,
    timezone: "America/Bogota",
    language: "spanish",
  });
}

function fullName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter((part) => part && part.trim() !== "").join(" ").trim();
  return name === "" ? null : name;
}
