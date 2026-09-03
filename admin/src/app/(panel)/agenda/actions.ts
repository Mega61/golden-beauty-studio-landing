"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/db/client";
import { stationRepository } from "@/db/repositories";

import type { GridProvider } from "@/lib/calendar-layout";
import {
  checkConflicts,
  type ConflictInput,
  type ConflictReport,
  type ServiceCapacity,
  type StationSlot,
} from "@/lib/conflict";
import { requireOwnProvider, requireSession } from "@/lib/dal";
import { createEaClient, type EaClient } from "@/lib/ea/client";
import { EaApiError } from "@/lib/ea/errors";
import { addDays, fetchWindow } from "@/components/calendar/range";
import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea/datetime";
import { eaDatePart, parseEaLocalDateTime } from "@/lib/ea/datetime";
import { planBlock, type BlockForm } from "./block-resource";
import { searchCustomers } from "./data";

/**
 * Las escrituras de la agenda.
 *
 * Cuatro reglas que valen para todas y que no son negociables:
 *
 * 1. **El DAL primero.** Cada acción llama a `requireSession()` —y a
 *    `requireOwnProvider()` cuando toca la columna de alguien— antes de mirar el
 *    formulario. Esconder un botón es cortesía con la usuaria; la acción que
 *    había detrás sigue existiendo y se puede invocar sin él.
 * 2. **Los choques se re-evalúan acá, contra datos frescos.** El cliente ya
 *    chequeó al abrir el diálogo; entre eso y el envío pasaron segundos y otra
 *    persona pudo agendar encima. Que dos personas editen a la vez es el caso
 *    normal de esta pantalla, no el raro.
 * 3. **Las dos severidades se pueden forzar.** `force: true` es el mismo modelo
 *    mental del `force_save` de EA. Un motor que impidiera guardar empujaría a
 *    la recepción a arreglarlo fuera del panel, que es donde el dato deja de
 *    existir.
 * 4. **Todo va por la API REST de EA, nunca a sus tablas.** Es lo que dispara
 *    sus notificaciones y el sync con Google Calendar.
 */

// ---------------------------------------------------------------------------
// Resultado común
// ---------------------------------------------------------------------------

export type WriteResult =
  | { status: "ok"; appointmentId?: number }
  /** Hay choques y no se mandó `force`. La UI muestra el reporte y reofrece. */
  | { status: "conflict"; report: ConflictReport }
  | { status: "error"; message: string };

export type AppointmentWrite = {
  /** Presente al mover o editar; ausente al crear. */
  id?: number;
  providerId: number;
  serviceId: number;
  customerId: number;
  start: string;
  end: string;
  notes?: string | null;
  status?: string;
  /** Guardar de todas formas. */
  force?: boolean;
};

// ---------------------------------------------------------------------------
// Crear / mover / editar
// ---------------------------------------------------------------------------

/**
 * Crea o reagenda una cita.
 *
 * Es una sola acción para las dos cosas porque la validación es idéntica y
 * partirla en dos duplicaría el re-chequeo de choques, que es la parte que no
 * se puede olvidar.
 */
export async function saveAppointment(input: AppointmentWrite): Promise<WriteResult> {
  // Una técnica solo toca su columna. `owner` y `reception` pasan siempre.
  await requireOwnProvider(input.providerId);

  const start = safeLocal(input.start);
  const end = safeLocal(input.end);
  if (!start || !end) {
    return { status: "error", message: "Las horas de la cita no son válidas." };
  }

  try {
    const client = createEaClient();
    const report = await evaluate(client, {
      id: input.id ?? null,
      providerId: input.providerId,
      serviceId: input.serviceId,
      start,
      end,
    });

    if (!report.ok && input.force !== true) {
      return { status: "conflict", report };
    }

    const body = {
      providerId: input.providerId,
      serviceId: input.serviceId,
      customerId: input.customerId,
      start,
      end,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };

    const saved =
      input.id === undefined
        ? await client.appointments.create(body)
        : await client.appointments.update(input.id, body);

    revalidatePath("/agenda");
    return { status: "ok", appointmentId: saved.id };
  } catch (error) {
    return failure(error, "No se pudo guardar la cita.");
  }
}

/**
 * Cambia el estado de una cita.
 *
 * No pasa por el chequeo de choques: mover el estado no mueve la cita. Sí pasa
 * por el DAL, y sí revalida, porque el color del cromo cambia para todo el
 * mundo.
 */
export async function setAppointmentStatus(
  id: number,
  providerId: number,
  status: string,
): Promise<WriteResult> {
  await requireOwnProvider(providerId);

  try {
    await createEaClient().appointments.update(id, { status });
    revalidatePath("/agenda");
    return { status: "ok", appointmentId: id };
  } catch (error) {
    return failure(error, "No se pudo cambiar el estado.");
  }
}

/**
 * Cancela una cita.
 *
 * **Es la excepción a "Deshacer en vez de confirmar"**: cancelar notifica a la
 * clienta, y una notificación no se deshace. La confirmación la pide la
 * pantalla; acá solo se ejecuta.
 *
 * Se cambia el estado, no se borra la fila: `DELETE /appointments/{id}` en EA
 * borra de verdad, y con eso se va la historia que después necesitan las
 * comisiones y los reportes.
 */
export async function cancelAppointment(
  id: number,
  providerId: number,
  status = "Cancelada",
): Promise<WriteResult> {
  return setAppointmentStatus(id, providerId, status);
}

/**
 * Busca clientas por nombre o teléfono, para el formulario de cita.
 *
 * Es un envoltorio de una línea sobre `searchCustomers()` de `data.ts`, que es
 * `server-only` y por eso no se puede llamar desde el navegador. La búsqueda
 * vive allá porque es una lectura de EA, y la acción vive acá porque es el
 * único borde por el que el cliente puede pedirla.
 */
export async function findCustomers(
  term: string,
): Promise<Array<{ id: number; name: string; phone: string | null }>> {
  return searchCustomers(term);
}

// ---------------------------------------------------------------------------
// Bloqueos
// ---------------------------------------------------------------------------

export type BlockResult =
  | { status: "ok"; created: number }
  | { status: "invalid"; errors: Array<{ field: string; message: string }> }
  | { status: "error"; message: string };

/**
 * "Bloquear": un formulario, tres recursos de EA.
 *
 * La elección la hace `planBlock()`, que es pura y está testeada; esto es lo que
 * la ejecuta. La validación se repite en el servidor aunque el cliente ya la
 * haya corrido — la acción se puede invocar sin pasar por el formulario.
 */
export async function saveBlock(form: BlockForm): Promise<BlockResult> {
  // Los bloqueos del estudio los pone quien tiene el estudio a cargo; el de una
  // técnica, ella misma o quien la administre. `requireOwnProvider(null)` deja
  // pasar a `owner` y `reception` y frena a una `staff` que apunte a otra.
  await requireOwnProvider(form.scope === "estudio" ? null : form.providerId);

  const planned = planBlock(form);
  if (!planned.ok) {
    return { status: "invalid", errors: planned.errors };
  }

  try {
    const client = createEaClient();
    const { plan } = planned;

    // En serie y no en paralelo: si el tercer día falla, los dos primeros ya
    // están escritos y la usuaria tiene que ver cuántos entraron. Con
    // `Promise.all` el error del tercero escondería que el primero sí pasó.
    //
    // El `switch` va **fuera** del bucle: adentro, TypeScript pierde el
    // discriminante y `plan.inputs[i]` vuelve a ser la unión de los tres
    // cuerpos. No es una pelea con el compilador: es que la unión discriminada
    // solo se estrecha una vez.
    let created = 0;

    switch (plan.resource) {
      case "blocked_periods":
        for (const input of plan.inputs) {
          await client.blockedPeriods.create(input);
          created += 1;
        }
        break;
      case "unavailabilities":
        for (const input of plan.inputs) {
          await client.unavailabilities.create(input);
          created += 1;
        }
        break;
      case "working_plan_exceptions":
        for (const input of plan.inputs) {
          await client.workingPlanExceptions.create(input);
          created += 1;
        }
        break;
    }

    revalidatePath("/agenda");
    return { status: "ok", created };
  } catch (error) {
    console.error("[agenda] no se pudo guardar el bloqueo", error);
    return {
      status: "error",
      message:
        error instanceof EaApiError
          ? "Easy!Appointments rechazó el bloqueo."
          : "No se pudo guardar el bloqueo.",
    };
  }
}

/** Quita un bloqueo. El "Deshacer" del toast llama acá. */
export async function removeBlock(
  resource: "blocked_periods" | "unavailabilities" | "working_plan_exceptions",
  id: number,
): Promise<WriteResult> {
  await requireSession();

  try {
    const client = createEaClient();
    if (resource === "blocked_periods") await client.blockedPeriods.remove(id);
    else if (resource === "unavailabilities") await client.unavailabilities.remove(id);
    else await client.workingPlanExceptions.remove(id);

    revalidatePath("/agenda");
    return { status: "ok" };
  } catch (error) {
    return failure(error, "No se pudo quitar el bloqueo.");
  }
}

// ---------------------------------------------------------------------------
// El re-chequeo contra datos frescos
// ---------------------------------------------------------------------------

/**
 * Vuelve a pedirle a EA el estado del día y corre `checkConflicts()`.
 *
 * Es deliberadamente una consulta más antes de cada escritura. La alternativa
 * —confiar en lo que el navegador tenía— es la que produce la doble reserva de
 * las 3 de la tarde de un sábado, que es justo cuando hay dos personas
 * agendando.
 */
async function evaluate(
  client: EaClient,
  candidate: {
    id: number | null;
    providerId: number;
    serviceId: number | null;
    start: EaLocalDateTime;
    end: EaLocalDateTime;
  },
): Promise<ConflictReport> {
  const days = [eaDatePart(candidate.start), eaDatePart(candidate.end)];
  const window = fetchWindow(days);

  const [appointments, unavailabilities, blockedPeriods, providers, services, exceptions] =
    await Promise.all([
      client.appointments.list({ from: window.from, till: window.till }),
      client.unavailabilities.list(),
      client.blockedPeriods.list(),
      client.providers.list(),
      client.services.list(),
      client.workingPlanExceptions.list(),
    ]);

  const provider = providers.find((p) => p.id === candidate.providerId);
  const gridProvider: Pick<GridProvider, "workingPlan" | "workingPlanExceptions"> | null = provider
    ? {
        workingPlan: provider.settings?.workingPlan ?? null,
        workingPlanExceptions: exceptions.filter((e) => e.providerId === provider.id),
      }
    : null;

  const capacities: ServiceCapacity[] = services.map((service) => ({
    id: service.id,
    attendantsNumber: service.attendantsNumber,
    // Ver la nota de `data.ts`: hoy los dos puestos aceptan cualquier categoría.
    category: null,
  }));

  const input: ConflictInput = {
    candidate,
    appointments,
    // Se acotan a los días del candidato: `checkConflicts()` filtra por solape
    // igual, pero cargarle un año de indisponibilidades es trabajo regalado.
    unavailabilities: unavailabilities.filter((item) => nearby(item, days)),
    blockedPeriods: blockedPeriods.filter((item) => nearby(item, days)),
    provider: gridProvider,
    services: capacities,
    stations: await loadStationsForCheck(),
  };

  return checkConflicts(input);
}

/**
 * Los puestos, otra vez.
 *
 * A diferencia de `data.ts`, acá **no** se atrapa el error: si `gbs_admin` no
 * responde, el chequeo de puestos no se puede hacer y escribir sin él sería
 * saltarse en silencio la restricción más fácil de olvidar del proyecto. La
 * acción falla y la pantalla lo dice. Leer con la base caída es aceptable;
 * escribir, no.
 */
async function loadStationsForCheck(): Promise<StationSlot[]> {
  const rows = await stationRepository(getDb()).listAll();
  return rows.map((row) => ({ id: row.id, name: row.name, allows: row.allows ?? null }));
}

function nearby(span: { start: string; end: string }, days: readonly EaLocalDate[]): boolean {
  const first = addDays(days[0], -1);
  const last = addDays(days[days.length - 1], 1);
  return span.start.slice(0, 10) <= last && span.end.slice(0, 10) >= first;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function safeLocal(value: string): EaLocalDateTime | null {
  try {
    return parseEaLocalDateTime(value);
  } catch {
    return null;
  }
}

/**
 * Un fallo de EA, traducido.
 *
 * El detalle va al log del servidor y a la pantalla llega una frase. Un
 * `error.message` crudo de EA trae la ruta y, en un 500, su stack de PHP.
 */
function failure(error: unknown, fallback: string): WriteResult {
  console.error(`[agenda] ${fallback}`, error);

  if (error instanceof EaApiError) {
    if (error.kind === "not_found") {
      return {
        status: "error",
        message: "Esa cita ya no existe en Easy!Appointments. Actualiza la agenda.",
      };
    }
    if (error.kind === "timeout" || error.kind === "network") {
      return { status: "error", message: "Easy!Appointments no respondió. No se guardó nada." };
    }
  }

  return { status: "error", message: fallback };
}
