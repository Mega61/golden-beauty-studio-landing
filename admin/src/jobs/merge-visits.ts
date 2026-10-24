import { COMBO_COMPOSITION } from "@/data/combo-composition";
import {
  appointmentFinanceRepository,
  appointmentPlannedServiceRepository,
  serviceMapRepository,
} from "@/db/repositories";
import type { Db } from "@/db/repositories/shared";
import { toEaIds } from "@/lib/combo-source";
import { addToBooking, type ComboComposition } from "@/lib/combos";
import type { EaClient } from "@/lib/ea/client";
import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";
import { groupVisits } from "@/lib/visits";

/**
 * Juntar en **una** cita las visitas de manos + pies que quedaron como dos.
 *
 * Hasta la migración `028`, un par sin combo se agendaba como dos citas
 * pegadas (misma persona, misma profesional, fin == inicio; `lib/visits.ts`).
 * La dueña pidió el 2026-10-24 una reserva y un bloque, siempre, y desde
 * entonces la agenda y `/reservar` crean una sola cita con el segundo servicio
 * en `appointment_planned_service`. Esto arregla las que ya existían.
 *
 * Por cada visita de dos o más citas:
 *
 * - la **primera** se queda, se estira hasta el fin de la última, y lleva los
 *   servicios de las demás como adicionales;
 * - si el par **es un combo** (semipermanente manos + pies agendado suelto),
 *   la cita pasa a ser el combo — el mismo `addToBooking()` del formulario. El
 *   rango no se toca: es la hora que la clienta tiene apartada;
 * - las demás se borran de EA.
 *
 * Lo que **no** se toca, y se lista para revisarlo a mano:
 *
 * - una visita con alguna cuenta ya abierta o cerrada (`appointment_finance`):
 *   esa plata ya está atada a sus ids;
 * - una visita cuyas citas tienen estados distintos (una cancelada y la otra
 *   no): juntarlas sería decidir cuál vale.
 *
 * Idempotente: una visita ya juntada es una cita sola y no vuelve a aparecer.
 */

export type MergeEa = Pick<EaClient, "appointments">;

export type VisitMerge = {
  keepId: number;
  removeIds: number[];
  /** El servicio con que queda la cita: el mismo, o el combo si el par lo es. */
  serviceId: number;
  /** El servicio que tenía, para el informe. */
  fromServiceId: number;
  end: EaLocalDateTime;
  extras: number[];
  start: EaLocalDateTime;
};

export type MergeSkip = {
  ids: number[];
  start: EaLocalDateTime;
  reason: "cuenta-abierta" | "estados-distintos" | "sin-servicio";
};

export type MergePlan = { merges: VisitMerge[]; skipped: MergeSkip[] };

/** Pura: las citas del rango → qué juntar y qué dejar. */
export function planVisitMerges(input: {
  appointments: readonly Appointment[];
  planned: ReadonlyMap<number, readonly number[]>;
  withFinance: ReadonlySet<number>;
  combos: readonly ComboComposition[];
}): MergePlan {
  const byId = new Map(input.appointments.map((a) => [a.id, a]));
  const visits = groupVisits(
    input.appointments.map((a) => ({
      id: a.id,
      customerId: a.customerId,
      providerId: a.providerId,
      start: a.start,
      end: a.end,
      serviceName: null,
    })),
  );

  const merges: VisitMerge[] = [];
  const skipped: MergeSkip[] = [];

  for (const chain of visits.values()) {
    if (chain.length < 2) continue;
    const parts = chain.map((p) => byId.get(p.id)!);
    const ids = parts.map((p) => p.id);
    const start = parts[0].start;

    if (ids.some((id) => input.withFinance.has(id))) {
      skipped.push({ ids, start, reason: "cuenta-abierta" });
      continue;
    }
    if (new Set(parts.map((p) => p.status)).size > 1) {
      skipped.push({ ids, start, reason: "estados-distintos" });
      continue;
    }

    const [leader, ...rest] = parts;
    if (leader.serviceId === null) {
      skipped.push({ ids, start, reason: "sin-servicio" });
      continue;
    }

    // Lo que ya tenía la primera, y después cada una de las otras con lo suyo,
    // por el mismo camino del formulario: si un par es combo, se vuelve combo.
    let booking = {
      serviceId: leader.serviceId as number | null,
      extras: [...(input.planned.get(leader.id) ?? [])],
    };
    for (const part of rest) {
      for (const id of [part.serviceId, ...(input.planned.get(part.id) ?? [])]) {
        if (id === null) continue;
        booking = addToBooking(input.combos, booking, id);
      }
    }

    merges.push({
      keepId: leader.id,
      removeIds: rest.map((p) => p.id),
      serviceId: booking.serviceId ?? leader.serviceId,
      fromServiceId: leader.serviceId,
      start,
      end: parts[parts.length - 1].end,
      extras: booking.extras,
    });
  }

  merges.sort((a, b) => a.start.localeCompare(b.start));
  skipped.sort((a, b) => a.start.localeCompare(b.start));
  return { merges, skipped };
}

export type MergeReport = {
  plan: MergePlan;
  applied: number[];
  failed: Array<{ keepId: number; error: string }>;
};

const DEFAULT_PAUSE_MS = 1_500;

/**
 * Lee el rango, planea y —con `apply`— escribe. En serie y con pausa entre
 * escrituras: EA corta a 100 peticiones cada 120 s por IP, y el panel en
 * servicio comparte esa IP.
 *
 * El orden de cada visita está pensado para que un corte a mitad deje algo
 * entendible: primero los adicionales en la base (invisibles hasta que la cita
 * se estire), después la cita estirada (en ese momento se encima con la
 * segunda, y la agenda lo muestra como choque), y al final se borran las otras.
 * Correr de nuevo termina lo que quedó.
 */
export async function runVisitMerges(options: {
  db: Db;
  ea: MergeEa;
  from: EaLocalDate;
  till: EaLocalDate;
  apply: boolean;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<MergeReport> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const log = options.log ?? (() => undefined);

  const appointments = await options.ea.appointments.list({ from: options.from, till: options.till });
  const ids = appointments.map((a) => a.id);
  const [planned, withFinance, serviceMap] = await Promise.all([
    appointmentPlannedServiceRepository(options.db).listByAppointments(ids),
    appointmentFinanceRepository(options.db).findExistingEaIds(ids),
    serviceMapRepository(options.db).listAll(),
  ]);
  const combos = toEaIds(
    COMBO_COMPOSITION,
    new Map(serviceMap.map((row) => [row.pricing_id, row.ea_service_id])),
  );

  const plan = planVisitMerges({ appointments, planned, withFinance, combos });
  const report: MergeReport = { plan, applied: [], failed: [] };
  if (!options.apply) return report;

  for (const [index, merge] of plan.merges.entries()) {
    if (index > 0 && pauseMs > 0) await sleep(pauseMs);
    try {
      await appointmentPlannedServiceRepository(options.db).replace(merge.keepId, merge.extras);
      await options.ea.appointments.update(merge.keepId, {
        end: merge.end,
        ...(merge.serviceId !== merge.fromServiceId ? { serviceId: merge.serviceId } : {}),
      });
      for (const id of merge.removeIds) {
        if (pauseMs > 0) await sleep(pauseMs);
        await options.ea.appointments.remove(id);
      }
      report.applied.push(merge.keepId);
      log(`juntar-visitas: ✓ ${merge.keepId} (${merge.start}) ← ${merge.removeIds.join(", ")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ keepId: merge.keepId, error: message });
      log(`juntar-visitas: ✗ ${merge.keepId} (${merge.start}): ${message}`);
    }
  }
  return report;
}

export function summarizeVisitMerges(report: MergeReport, apply: boolean): string {
  const { merges, skipped } = report.plan;
  const head = apply
    ? `juntar-visitas: ${report.applied.length} de ${merges.length} visitas juntadas en una cita`
    : `juntar-visitas: ${merges.length} visitas para juntar en una cita`;
  const tail = [
    skipped.length > 0 ? `${skipped.length} sin tocar (revisar a mano)` : null,
    report.failed.length > 0 ? `${report.failed.length} fallaron` : null,
  ].filter(Boolean);
  return tail.length > 0 ? `${head}; ${tail.join(", ")}.` : `${head}.`;
}
