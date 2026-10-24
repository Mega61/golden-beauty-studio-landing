import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { ForbiddenError, requireCapability } from "@/lib/dal";

import { registerManualConfirmation } from "../../recordatorios/confirmation-send";

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
 * manda al login; sin permiso, a la agenda.
 *
 * **Queda registrada**, como cualquier confirmación manual
 * (`registerManualConfirmation`): así "Reservas nuevas" la muestra confirmada
 * y nadie le escribe dos veces. Si no se puede mandar —sin teléfono, cancelada,
 * la base no responde— se cae a Recordatorios, donde la fila dice por qué.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<never> {
  const { id } = await params;
  const appointmentId = Number(id);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) redirect("/agenda");

  let session;
  try {
    session = await requireCapability("recordatorios:enviar");
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/agenda");
    throw error;
  }

  const result = await registerManualConfirmation(appointmentId, {
    userId: session.userId,
    name: session.name,
  });
  if (!result.ok) {
    console.error("[confirmar] no se abrió WhatsApp", appointmentId, result.message);
  }

  redirect(result.ok ? result.url : "/recordatorios");
}
