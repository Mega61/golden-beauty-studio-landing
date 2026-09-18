import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isEaLocalDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
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
  if (!isEaLocalDate(date)) return bad("date");
  if (!/^\d{2}:\d{2}$/.test(time)) return bad("time");
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
        return NextResponse.json(
          {
            appointmentId: result.appointmentId,
            // La clienta nunca se entera de que "cualquiera" fue una decisión
            // nuestra: ve un nombre.
            provider: { id: result.providerId, name: result.providerName },
            start: result.start,
            end: result.end,
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

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bad(field: string) {
  return NextResponse.json({ error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
