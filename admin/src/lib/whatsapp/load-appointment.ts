import "server-only";

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { createEaClient } from "@/lib/ea/client";

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
