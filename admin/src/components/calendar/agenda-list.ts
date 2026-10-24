import type { GridProvider } from "@/lib/calendar-layout";
import type { EaLocalDate } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";

/**
 * La agenda en lista: los días uno debajo del otro y, en cada uno, las citas
 * en orden de hora. Es la vista "Agenda" de Google Calendar y la que la dueña
 * usaba en Agenda Pro para leer la semana de un vistazo, sobre todo en el
 * celular, donde la grilla solo cabe de a un día.
 *
 * Puro: recibe lo mismo que la grilla —citas y técnicas ya recortadas por rol,
 * con el historial de Agenda Pro ya convertido en citas sintéticas— y solo
 * decide el orden. Nada de lo que la grilla esconde por estar fuera de la
 * jornada visible se esconde acá: una lista no tiene "antes de las 8".
 */

export type AgendaListRow = {
  appointment: Appointment;
  providerName: string;
};

export type AgendaListDay = {
  date: EaLocalDate;
  rows: AgendaListRow[];
};

/**
 * Agrupa por el día en que **empieza** cada cita, en el orden de `dates`.
 *
 * Dentro del día: por hora de inicio, después por el orden de las columnas de
 * la grilla (el mismo que ve la recepción) y al final por id, para que dos
 * refrescos seguidos no intercambien filas que empiezan a la misma hora.
 */
export function buildAgendaList(
  dates: readonly EaLocalDate[],
  layers: ReadonlyMap<EaLocalDate, { providers: readonly GridProvider[]; appointments: readonly Appointment[] }>,
): AgendaListDay[] {
  return dates.map((date) => {
    const layer = layers.get(date);
    if (!layer) return { date, rows: [] };

    const order = new Map(layer.providers.map((p, i) => [p.id, i]));
    const names = new Map(layer.providers.map((p) => [p.id, p.name]));

    const rows = layer.appointments
      .filter((a) => a.start.slice(0, 10) === date)
      // Una cita sin columna no se pierde: la grilla la reporta como huérfana y
      // acá sale igual, con "Sin profesional".
      .map((appointment) => ({
        appointment,
        providerName:
          appointment.providerId === null
            ? "Sin profesional"
            : (names.get(appointment.providerId) ?? "Sin profesional"),
      }))
      .sort(
        (a, b) =>
          a.appointment.start.localeCompare(b.appointment.start) ||
          rank(order, a.appointment.providerId) - rank(order, b.appointment.providerId) ||
          a.appointment.id - b.appointment.id,
      );

    return { date, rows };
  });
}

function rank(order: ReadonlyMap<number, number>, providerId: number | null): number {
  return providerId === null ? Number.MAX_SAFE_INTEGER : (order.get(providerId) ?? Number.MAX_SAFE_INTEGER);
}
