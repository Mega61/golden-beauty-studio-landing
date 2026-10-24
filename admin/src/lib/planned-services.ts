import "server-only";

import { getDb } from "@/db/client";
import { appointmentPlannedServiceRepository } from "@/db/repositories";
import type { Db } from "@/db/repositories/shared";
import type { AppointmentWithRelations, EaClient } from "@/lib/ea/client";
import { visitServiceName } from "@/lib/visits";

/**
 * Los servicios de una cita **además** del principal (migración `028`): el
 * "+ pies" de manos y pies que no son combo, agendados como **una** cita.
 *
 * EA solo sabe del servicio principal. Todo lo que nombra la cita para afuera
 * —la confirmación y los recordatorios por WhatsApp, el aviso push, la lista de
 * Recordatorios— tiene que nombrar también los otros, o la clienta lee
 * "Esculpidas en acrílico" y llega pensando que los pies no quedaron. Este
 * módulo es el único que los junta.
 */

/**
 * Los adicionales de estas citas. **Nunca lanza**: sin `gbs_admin` cada cita se
 * nombra con su servicio principal, que es lo que EA sabe — un mensaje con un
 * servicio de menos es mejor que un mensaje que no sale.
 */
export async function loadPlannedServices(
  eaAppointmentIds: readonly number[],
  db?: Db,
): Promise<Map<number, number[]>> {
  if (eaAppointmentIds.length === 0) return new Map();
  try {
    return await appointmentPlannedServiceRepository(db ?? getDb()).listByAppointments(
      eaAppointmentIds,
    );
  } catch (error) {
    console.error("[servicios adicionales] no se pudieron leer", error);
    return new Map();
  }
}

/** "Esculpidas en acrílico y Semipermanente pies". Ver `visitServiceName`. */
export function namesWithExtras(
  mainName: string | null,
  extraIds: readonly number[],
  nameOf: (id: number) => string | null,
): string | null {
  if (extraIds.length === 0) return mainName;
  return visitServiceName([mainName, ...extraIds.map(nameOf)]);
}

/**
 * Las mismas filas de EA, con el nombre del servicio de cada cita reemplazado
 * por el de la cita entera ("X y Y") cuando tiene adicionales.
 *
 * Se reescribe `service.name` y nada más —el id sigue siendo el del principal—
 * para que quien ya arma mensajes con `service?.name` diga lo correcto sin
 * saber que existen los adicionales. El catálogo se pide solo si alguna cita
 * tiene adicionales.
 */
export async function withPlannedServiceNames(
  ea: Pick<EaClient, "raw">,
  rows: readonly AppointmentWithRelations[],
  db?: Db,
): Promise<AppointmentWithRelations[]> {
  const planned = await loadPlannedServices(
    rows.map((r) => r.appointment.id),
    db,
  );
  if (planned.size === 0) return [...rows];

  let names = new Map<number, string>();
  try {
    // Por el acceso crudo: es lo único que tienen todos los que llaman (el
    // job de recordatorios recibe solo `raw`). El catálogo cabe en una página.
    const payload = await ea.raw({
      method: "GET",
      path: "services",
      params: new URLSearchParams({ length: "500" }),
    });
    if (!Array.isArray(payload)) throw new Error("EA devolvió algo que no es una lista de servicios");
    names = new Map(
      (payload as Array<{ id?: unknown; name?: unknown }>).flatMap((s) =>
        typeof s.id === "number" ? [[s.id, typeof s.name === "string" ? s.name : `Servicio ${s.id}`] as const] : [],
      ),
    );
  } catch (error) {
    console.error("[servicios adicionales] no se pudo leer el catálogo para nombrarlos", error);
    return [...rows];
  }

  return rows.map((row) => {
    const extras = planned.get(row.appointment.id);
    if (!extras || extras.length === 0 || row.service === null) return row;
    return {
      ...row,
      service: {
        ...row.service,
        name: namesWithExtras(row.service.name ?? null, extras, (id) => names.get(id) ?? null),
      },
    };
  });
}
