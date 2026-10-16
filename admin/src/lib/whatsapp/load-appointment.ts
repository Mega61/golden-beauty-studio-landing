import "server-only";

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { createEaClient } from "@/lib/ea/client";

import { groupVisits, visitServiceName } from "@/lib/visits";

import type { ManualReminderAppointment } from "./manual-reminder";

/**
 * Una cita de EA, reducida a lo que necesitan los mensajes por WhatsApp
 * (recordatorio y confirmación). Vive acá y no en una Server Action porque la
 * usan dos: `recordatorios/actions.ts` y la ruta `/confirmar/[id]`.
 */
export async function loadAppointmentForMessage(
  eaAppointmentId: number,
): Promise<ManualReminderAppointment> {
  const ea = createEaClient();
  const appointment = await ea.appointments.get(eaAppointmentId);
  const [customer, service] = await Promise.all([
    appointment.customerId === null ? null : ea.customers.get(appointment.customerId),
    appointment.serviceId === null ? null : ea.services.get(appointment.serviceId),
  ]);
  return {
    eaAppointmentId: appointment.id,
    start: appointment.start,
    status: appointment.status,
    phoneE164: normalizePhoneE164(customer?.phone ?? null),
    customerFirstName: customer?.firstName ?? null,
    customerName:
      [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || "Sin clienta",
    serviceName: service?.name ?? null,
  };
}

/** Lo que necesitan las plantillas de la Cloud API, además de lo del recordatorio manual. */
export type TemplateAppointmentData = ManualReminderAppointment & {
  providerFirstName: string | null;
  /**
   * Esta cita sigue a otra de la misma visita (manos + pies sin combo): el
   * mensaje lo lleva la primera, que nombra los dos servicios.
   */
  continuation: boolean;
};

/**
 * La cita con la técnica, para las plantillas de Meta (`{{4}}` la nombra).
 *
 * Lee **fresco** (`createEaClient()` no usa la caché): la confirmación sale
 * segundos después de crear la cita, y una lectura de caché de antes de
 * crearla diría que no existe.
 */
export async function loadAppointmentForTemplate(
  eaAppointmentId: number,
): Promise<TemplateAppointmentData> {
  const ea = createEaClient();
  const appointment = await ea.appointments.get(eaAppointmentId);
  const day = String(appointment.start).slice(0, 10);
  const [customer, service, provider, sameDay] = await Promise.all([
    appointment.customerId === null ? null : ea.customers.get(appointment.customerId),
    appointment.serviceId === null ? null : ea.services.get(appointment.serviceId),
    appointment.providerId === null ? null : ea.providers.get(appointment.providerId),
    ea.appointments.list({ from: day as never, till: day as never }),
  ]);

  // ¿Es parte de una visita de varias citas? Ver `lib/visits.ts`.
  const visits = groupVisits(
    sameDay.map((a) => ({
      id: a.id,
      customerId: a.customerId,
      providerId: a.providerId,
      start: String(a.start),
      end: String(a.end),
      serviceName: null,
    })),
  );
  const chain = [...visits.values()].find((parts) => parts.some((p) => p.id === appointment.id));
  const continuation = chain !== undefined && chain[0].id !== appointment.id;
  let serviceName = service?.name ?? null;
  if (chain && chain.length > 1 && !continuation) {
    const services = await Promise.all(
      chain.map((part) => {
        const row = sameDay.find((a) => a.id === part.id);
        return row?.serviceId == null ? null : ea.services.get(row.serviceId);
      }),
    );
    serviceName = visitServiceName(services.map((svc) => svc?.name ?? null)) ?? serviceName;
  }
  return {
    eaAppointmentId: appointment.id,
    start: appointment.start,
    status: appointment.status,
    phoneE164: normalizePhoneE164(customer?.phone ?? null),
    customerFirstName: customer?.firstName ?? null,
    customerName:
      [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || "Sin clienta",
    serviceName,
    providerFirstName: provider?.firstName ?? null,
    continuation,
  };
}
