import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { ForbiddenError, requireCapability } from "@/lib/dal";
import { loadAppointmentForMessage } from "@/lib/whatsapp/load-appointment";
import { buildConfirmationText, waMeLink } from "@/lib/whatsapp/manual-reminder";

/**
 * `/admin/confirmar/:id` — el botón "Escribirle por WhatsApp" del aviso de
 * nueva reserva.
 *
 * ## Por qué una ruta y no el enlace dentro del aviso
 *
 * El aviso nunca lleva el teléfono de la clienta (`lib/push/payload.ts`, con
 * un test que lo exige): se ve en una pantalla de bloqueo. Así que el botón
 * trae solo el id de la cita, y el número se resuelve acá, del lado del
 * servidor, con sesión. Para quien toca es lo mismo —un toque y está en el
 * chat con el mensaje escrito— y el número no viaja por el servicio de push.
 *
 * Mismo permiso que los recordatorios: el mensaje sale del WhatsApp del
 * estudio, y eso es de la dueña y de recepción. Sin sesión, `requireSession`
 * manda al login; sin permiso o sin teléfono, a la agenda de ese día, donde
 * está la cita para resolverlo a mano.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<never> {
  const { id } = await params;
  const appointmentId = Number(id);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) redirect("/agenda");

  try {
    await requireCapability("recordatorios:enviar");
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/agenda");
    throw error;
  }

  let link: string | null = null;
  let day: string | null = null;
  try {
    const appointment = await loadAppointmentForMessage(appointmentId);
    day = appointment.start.slice(0, 10);
    if (appointment.phoneE164 !== null) {
      link = waMeLink(appointment.phoneE164, buildConfirmationText(appointment));
    }
  } catch (error) {
    console.error("[confirmar] no se pudo leer la cita", appointmentId, error);
  }

  redirect(link ?? (day ? `/agenda?dia=${day}` : "/agenda"));
}
