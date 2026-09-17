import "server-only";

import { getDb } from "@/db/client";
import { stationRepository } from "@/db/repositories";
import { createEaClient, type EaClient } from "@/lib/ea/client";
import { eaDatePart, type EaLocalDate } from "@/lib/ea/datetime";
import { providerWorkingPlanExceptions } from "@/lib/ea/mapping";
import { publicSlots, type ProviderOffer, type PublicSlot } from "@/lib/public-availability";

/**
 * El abanico de disponibilidad pública: la parte con E/S.
 *
 * El cruce contra los puestos vive en `lib/public-availability.ts`, que es puro
 * y se testea solo. Acá está lo que no se puede testear sin red: pedirle a EA
 * una llamada **por técnica** (su API no tiene "cualquiera") y juntar la
 * ocupación del día de todas, no solo la de quien se consulta — sin las de las
 * demás la cuenta de sillas da de más.
 */

export type AvailabilityQuery = {
  /** Id del servicio en EA. Un combo es un servicio más. */
  serviceId: number;
  date: EaLocalDate;
  /** Si la clienta eligió técnica. Sin esto, es "cualquiera". */
  providerId?: number | null;
};

export type AvailabilityResult =
  | { status: "ok"; slots: PublicSlot[] }
  | { status: "unknown-service" }
  /** El servicio existe pero no se agenda solo. Ver abajo. */
  | { status: "unbookable-service" }
  | { status: "no-providers" };

export async function loadAvailability(
  query: AvailabilityQuery,
  client: EaClient = createEaClient(),
): Promise<AvailabilityResult> {
  const [services, providers] = await Promise.all([
    client.services.list(),
    client.providers.list(),
  ]);

  const service = services.find((s) => s.id === query.serviceId);
  if (!service) return { status: "unknown-service" };

  // Sin duración no hay tramo que reservar. No es un dato faltante: son los
  // adicionales de `extras` que se cobran por uña (`design-per-nail`), que se
  // suman a una cita pero no son una cita. Decirlo es más útil que devolver
  // una lista vacía y dejar a la clienta mirando un día sin horas.
  const duration = service.duration;
  if (duration === null || duration <= 0) return { status: "unbookable-service" };

  // Una técnica solo aparece si EA la tiene habilitada para ese servicio. Y si
  // la clienta eligió a alguien, el abanico es de una sola.
  const eligible = providers.filter(
    (provider) =>
      (provider.services ?? []).includes(service.id) &&
      (query.providerId == null || provider.id === query.providerId),
  );
  if (eligible.length === 0) return { status: "no-providers" };

  const stations = await stationRepository(getDb()).listAll();

  // El día entero, de todas las técnicas.
  const [appointments, unavailabilities, blockedPeriods] = await Promise.all([
    client.appointments.list({ from: query.date, till: query.date }),
    client.unavailabilities.list(),
    client.blockedPeriods.list(),
  ]);

  const sameDay = <T extends { start: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => eaDatePart(row.start as never) === query.date);

  // El abanico. Secuencial a propósito: EA corta a 100 peticiones por IP cada
  // 120 s desde `EA_Controller`, y con dos técnicas no se gana nada en
  // paralelo salvo acercarse al tope.
  const offers: ProviderOffer[] = [];
  for (const provider of eligible) {
    const availability = await client.availabilities({
      providerId: provider.id,
      serviceId: service.id,
      date: query.date,
    });

    offers.push({
      providerId: provider.id,
      hours: availability.hours,
      plan: {
        workingPlan: provider.settings?.workingPlan ?? null,
        workingPlanExceptions: providerWorkingPlanExceptions(provider),
      },
    });
  }

  // ⚠ Misma deuda —y misma razón— que `(panel)/agenda/data.ts`: la categoría de
  // `pricing.ts` sale de `service_map` cruzado con el catálogo de la vitrina,
  // que vive en la landing y no en `admin/`. Hoy los dos puestos tienen
  // `allows: NULL` (cualquier categoría), así que `null` da exactamente el
  // mismo resultado. El día que un puesto se especialice, esto **tiene** que
  // dejar de ser `null` o la landing empezará a ofrecer horas que no caben.
  const capacities = services.map((s) => ({
    id: s.id,
    attendantsNumber: s.attendantsNumber,
    category: null,
  }));

  return {
    status: "ok",
    slots: publicSlots({
      date: query.date,
      service: {
        id: service.id,
        attendantsNumber: service.attendantsNumber,
        category: null,
        durationMin: duration,
      },
      offers,
      appointments: sameDay(appointments),
      unavailabilities: sameDay(unavailabilities),
      blockedPeriods,
      services: capacities,
      // `allows` es JSONColumnType: Kysely ya lo entrega parseado.
      stations: stations.map((s) => ({ id: s.id, name: s.name, allows: s.allows })),
    }),
  };
}
