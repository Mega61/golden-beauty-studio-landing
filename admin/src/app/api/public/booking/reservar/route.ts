import { after, NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createEaClient } from "@/lib/ea/client";
import { isEaLocalDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
import { notifyNewWebBooking } from "@/lib/push/send";
import { whatsappConfirmationFor } from "@/lib/whatsapp/booking-confirmation";
import { sendAppointmentConfirmation } from "@/lib/whatsapp/confirmation";
import { visitServiceName } from "@/lib/visits";
import { createBooking } from "./data";

/**
 * Confirma una reserva pública. La segunda —y última— ruta pública del panel.
 *
 * Las defensas anti-abuso (Turnstile, honeypot, tiempo mínimo, límite por IP)
 * viven en el proxy de la landing, que es quien ve al navegador; acá se asume
 * que ya pasaron. Lo que **no** se delega es la verificación del hueco: la hace
 * `createBooking` contra datos frescos, porque el cliente puede mandar
 * cualquier cosa y porque entre listar y confirmar pasan minutos.
 *
 * `taken` responde **409**, no 400: no es un pedido mal formado, es una carrera
 * que se perdió, y la landing tiene que reaccionar distinto — recargar los
 * horarios y pedir que elija otro, sin culpar a la clienta.
 */
export const dynamic = "force-dynamic";

const MAX_LEN = 120;
const MAX_NOTES = 500;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body");
  }

  if (typeof body !== "object" || body === null) return bad("body");
  const raw = body as Record<string, unknown>;

  const serviceId = Number(raw.serviceId);
  const thenServiceId =
    raw.thenServiceId === null || raw.thenServiceId === undefined || raw.thenServiceId === ""
      ? null
      : Number(raw.thenServiceId);
  const date = raw.date;
  const time = str(raw.time);
  const firstName = str(raw.firstName);
  const lastName = str(raw.lastName);
  const phone = str(raw.phone);
  const notes = str(raw.notes);
  const providerId =
    raw.providerId === null || raw.providerId === undefined || raw.providerId === ""
      ? null
      : Number(raw.providerId);

  if (!Number.isInteger(serviceId) || serviceId <= 0) return bad("serviceId");
  if (
    thenServiceId !== null &&
    (!Number.isInteger(thenServiceId) || thenServiceId <= 0 || thenServiceId === serviceId)
  ) {
    return bad("thenServiceId");
  }
  if (!isEaLocalDate(date)) return bad("date");
  if (!isWallTime(time)) return bad("time");
  if (providerId !== null && (!Number.isInteger(providerId) || providerId <= 0)) {
    return bad("providerId");
  }
  if (firstName === "" || firstName.length > MAX_LEN) return bad("firstName");
  if (lastName === "" || lastName.length > MAX_LEN) return bad("lastName");
  if (phone === "" || phone.length > MAX_LEN) return bad("phone");
  if (notes.length > MAX_NOTES) return bad("notes");

  try {
    const result = await createBooking({
      serviceId,
      thenServiceId,
      date,
      time,
      providerId,
      firstName,
      lastName,
      phone,
      notes: notes || null,
    });

    switch (result.status) {
      case "ok":
        // El aviso al celular de la dueña y de recepción va en `after()`:
        // corre cuando la clienta ya tiene su 201. Un servicio de push lento o
        // caído no puede demorar ni tumbar una reserva que ya existe en EA, y
        // `notifyNewWebBooking` no lanza. El teléfono de la clienta **no**
        // entra: el aviso se ve en una pantalla de bloqueo.
        after(() =>
          notifyNewWebBooking({
            appointmentId: result.appointmentId,
            customerFirstName: firstName,
            customerLastName: lastName,
            start: result.start,
            providerName: result.providerName,
            // Un par se anuncia como una sola reserva: "Semipermanente manos y
            // Semipermanente pies".
            resolveServiceName: async () => {
              const ea = createEaClient();
              const ids = thenServiceId ? [serviceId, thenServiceId] : [serviceId];
              const services = await Promise.all(ids.map((id) => ea.services.get(id)));
              return visitServiceName(services.map((s) => s.name ?? null));
            },
          }),
        );
        // La confirmación por WhatsApp, por el mismo camino: después del 201,
        // y sin poder tumbarlo. `whatsappConfirmation` le dice a la landing si
        // va a intentarse, para que la pantalla de éxito no prometa un mensaje
        // que no va a salir (sin Meta configurado, o número dado de baja).
        const whatsappConfirmation = await whatsappConfirmationFor(phone);
        if (whatsappConfirmation === "sending") {
          after(() => sendAppointmentConfirmation(result.appointmentId).then(() => undefined));
        }
        return NextResponse.json(
          {
            appointmentId: result.appointmentId,
            // La clienta nunca se entera de que "cualquiera" fue una decisión
            // nuestra: ve un nombre.
            provider: { id: result.providerId, name: result.providerName },
            start: result.start,
            end: result.end,
            whatsappConfirmation,
          },
          { status: 201, headers: NO_STORE },
        );
      case "taken":
        return NextResponse.json({ error: "taken" }, { status: 409, headers: NO_STORE });
      case "invalid-phone":
        return bad("phone");
      case "unknown-service":
        return bad("serviceId");
    }
  } catch (error) {
    console.error("[public/booking/reservar] no se pudo crear la cita", error);

    const transient = error instanceof EaApiError ? error.isTransient : true;
    return NextResponse.json(
      { error: "unavailable" },
      { status: transient ? 503 : 500, headers: NO_STORE },
    );
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `HH:MM` de un reloj que existe.
 *
 * El patrón de antes era `/^\d{2}:\d{2}$/`, que acepta `25:99`. Con eso, una
 * hora imposible pasaba la validación, no encontraba hueco y salía como **409
 * `taken`** — "esa hora se acaba de ocupar" sobre una hora que no existe. Es
 * una mentira barata de arreglar y cara de depurar desde el otro lado: quien
 * integra ve una carrera perdida donde hay un bug suyo.
 */
function isWallTime(value: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bad(field: string) {
  return NextResponse.json({ error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
