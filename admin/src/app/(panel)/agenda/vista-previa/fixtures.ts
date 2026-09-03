import { parseEaLocalDate, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea/datetime";
import type { ConflictReport } from "@/lib/conflict";
import type { Appointment, WorkingPlan } from "@/lib/ea/types";
import type { AgendaData } from "../data";

/**
 * Un día inventado para revisar la agenda con los ojos.
 *
 * Existe por una razón concreta: la Definition of Done de este paquete pide
 * revisarla **en navegador a 390 / 768 / 1440**, y sin datos no hay nada que
 * mirar. Levantar Easy!Appointments, correr su asistente de instalación y
 * sembrar tres técnicas para comprobar que un bloque de 15 minutos se lee es
 * una hora de trabajo que no prueba nada del panel.
 *
 * **No es un modo de demostración.** La ruta que lo usa responde 404 en
 * producción y estos datos no tocan ningún camino real: `AgendaClient` los
 * recibe como props, igual que recibiría los de EA.
 *
 * Lo que trae está elegido para que los casos difíciles se vean sin buscarlos:
 *
 * - dos citas **encimadas** en la misma columna (la API de EA las acepta);
 * - una cita **antes** del inicio de la jornada, que sale como contador de
 *   ocultas en vez de desaparecer;
 * - una **huérfana**, de una técnica que no está en la lista;
 * - un **estado que el panel no reconoce**, que se dibuja punteado;
 * - un **bloqueo del estudio**, una **indisponibilidad** y un **descanso**;
 * - una cita de **quince minutos**, para ver si un bloque mínimo se puede tocar;
 * - una **excepción de plan** que le cambia el horario a una técnica.
 */

const PLAN = (start: string, end: string, breaks: Array<{ start: string; end: string }> = []) => ({
  start,
  end,
  breaks,
});

function weekPlan(
  start: string,
  end: string,
  breaks: Array<{ start: string; end: string }> = [],
): WorkingPlan {
  const day = PLAN(start, end, breaks);
  return {
    sunday: null,
    monday: day,
    tuesday: day,
    wednesday: day,
    thursday: day,
    friday: day,
    saturday: PLAN(start, "16:00", breaks),
  };
}

function appointment(
  id: number,
  providerId: number | null,
  date: EaLocalDate,
  from: string,
  till: string,
  status: string,
  serviceId: number,
  color: string | null = null,
): Appointment {
  return {
    id,
    bookedAt: null,
    start: `${date} ${from}:00` as EaLocalDateTime,
    end: `${date} ${till}:00` as EaLocalDateTime,
    hash: null,
    location: null,
    meetingLink: null,
    color,
    status,
    notes: null,
    customerId: 500 + id,
    providerId,
    serviceId,
    googleCalendarId: null,
    caldavCalendarId: null,
  };
}

export function previewData(today: EaLocalDate): AgendaData {
  const d = parseEaLocalDate(today);

  return {
    providers: [
      {
        id: 1,
        name: "Lina Restrepo",
        workingPlan: weekPlan("09:00", "19:00", [{ start: "13:00", end: "14:00" }]),
        workingPlanExceptions: [],
      },
      {
        id: 2,
        name: "Marcela Ossa",
        workingPlan: weekPlan("08:00", "17:00"),
        // Ese día entra a las 11 en vez de a las 8: la excepción reemplaza al
        // plan entero, descansos incluidos.
        workingPlanExceptions: [
          {
            id: 90,
            startDate: d,
            endDate: d,
            startTime: "11:00",
            endTime: "20:00",
            breaks: [],
            providerId: 2,
          },
        ],
      },
      {
        id: 3,
        name: "Daniela Cano",
        workingPlan: weekPlan("10:00", "18:00"),
        workingPlanExceptions: [],
      },
    ],

    appointments: [
      // Antes de que abra la jornada visible: sale como "1 cita antes".
      appointment(10, 1, d, "07:00", "07:45", "Confirmada", 1, "#7cbae8"),
      appointment(11, 1, d, "09:00", "11:30", "Confirmada", 1, "#7cbae8"),
      // Encimadas: la API de EA lo permite y la grilla tiene que dibujarlo.
      appointment(12, 1, d, "11:00", "12:00", "Reservada", 2, "#c98bb9"),
      appointment(13, 1, d, "14:00", "14:15", "Completada", 3, "#8fbf7f"),
      appointment(14, 2, d, "11:00", "13:30", "Reservada", 1, "#7cbae8"),
      appointment(15, 2, d, "15:00", "17:00", "No asistió", 4, "#e0a94f"),
      appointment(16, 3, d, "10:30", "12:00", "Cancelada", 2, "#c98bb9"),
      // Un estado que el panel no conoce: punteado y en el aviso de arriba.
      appointment(17, 3, d, "13:00", "15:00", "Pendiente de abono", 5, null),
      appointment(18, 3, d, "16:00", "19:30", "Confirmada", 1, "#7cbae8"),
      // Huérfana: su técnica no está en la lista.
      appointment(19, 77, d, "12:00", "13:00", "Reservada", 1, null),
    ],

    unavailabilities: [
      {
        id: 40,
        bookedAt: null,
        start: `${d} 16:00:00` as EaLocalDateTime,
        end: `${d} 18:00:00` as EaLocalDateTime,
        hash: null,
        location: null,
        notes: "Cita médica",
        providerId: 1,
        googleCalendarId: null,
        caldavCalendarId: null,
      },
    ],

    blockedPeriods: [
      {
        id: 60,
        name: "Fumigación",
        start: `${d} 19:00:00` as EaLocalDateTime,
        end: `${d} 20:00:00` as EaLocalDateTime,
        notes: null,
      },
    ],

    meta: {
      10: { customer: "Sara Gómez", service: "Retoque acrílicas", serviceColor: "#7cbae8", phone: "+573001112233" },
      11: { customer: "Marcela Duque", service: "Acrílicas esculpidas", serviceColor: "#7cbae8", phone: "+573001112234" },
      12: { customer: "Paula Arenas", service: "Semipermanente", serviceColor: "#c98bb9", phone: null },
      13: { customer: "Ana Mesa", service: "Diseño extra", serviceColor: "#8fbf7f", phone: null },
      14: { customer: "Luisa Pérez", service: "Acrílicas esculpidas", serviceColor: "#7cbae8", phone: "+573001112235" },
      15: { customer: "Carolina Vélez", service: "Spa de pies", serviceColor: "#e0a94f", phone: null },
      16: { customer: "Juliana Toro", service: "Semipermanente", serviceColor: "#c98bb9", phone: null },
      17: { customer: "Valeria Ruiz", service: "Combo manos y pies", serviceColor: null, phone: null },
      18: { customer: "Natalia Cruz", service: "Acrílicas esculpidas", serviceColor: "#7cbae8", phone: "+573001112236" },
      19: { customer: "Sin asignar", service: "Semipermanente", serviceColor: null, phone: null },
    },

    services: [
      { id: 1, name: "Acrílicas esculpidas", duration: 150, attendantsNumber: 1 },
      { id: 2, name: "Semipermanente", duration: 90, attendantsNumber: 1 },
      { id: 3, name: "Diseño extra", duration: 15, attendantsNumber: 1 },
      { id: 4, name: "Spa de pies", duration: 120, attendantsNumber: 2 },
      { id: 5, name: "Combo manos y pies", duration: 210, attendantsNumber: 1 },
    ],

    capacities: [
      { id: 1, attendantsNumber: 1, category: null },
      { id: 2, attendantsNumber: 1, category: null },
      { id: 3, attendantsNumber: 1, category: null },
      { id: 4, attendantsNumber: 2, category: null },
      { id: 5, attendantsNumber: 1, category: null },
    ],

    stations: [
      { id: 1, name: "Puesto 1", allows: null },
      { id: 2, name: "Puesto 2", allows: null },
    ],

    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Un reporte de choques de muestra, con las dos severidades y los cinco tipos
 * de sujeto.
 *
 * Es lo único que la vista previa no puede producir sola: el reporte lo arma el
 * servidor al enviar, contra datos frescos. Sin esto, la parte de la pantalla
 * que más importa revisar —la que dice "Lina ya tiene a Marcela de 2 a 3:30"—
 * no se podría mirar sin Easy!Appointments levantado.
 */
export function previewConflicts(today: EaLocalDate): ConflictReport {
  const d = parseEaLocalDate(today);
  return {
    ok: false,
    hard: true,
    conflicts: [
      {
        reason: "provider-busy",
        severity: "hard",
        message: "La profesional ya tiene otra cita en ese horario.",
        window: {
          start: `${d} 14:00:00` as EaLocalDateTime,
          end: `${d} 15:30:00` as EaLocalDateTime,
        },
        with: [
          {
            kind: "appointment",
            id: 11,
            providerId: 1,
            serviceId: 1,
            status: "Confirmada",
            start: `${d} 09:00:00` as EaLocalDateTime,
            end: `${d} 11:30:00` as EaLocalDateTime,
          },
        ],
      },
      {
        reason: "no-station",
        severity: "hard",
        message: "No queda puesto libre: 3 citas a la vez y 2 puestos.",
        window: {
          start: `${d} 14:00:00` as EaLocalDateTime,
          end: `${d} 15:30:00` as EaLocalDateTime,
        },
        with: [
          {
            kind: "station",
            at: `${d} 14:00:00` as EaLocalDateTime,
            needed: 3,
            seated: 2,
            total: 2,
          },
        ],
      },
      {
        reason: "during-break",
        severity: "soft",
        message: "La cita cae dentro de un descanso de la profesional.",
        window: {
          start: `${d} 13:00:00` as EaLocalDateTime,
          end: `${d} 14:00:00` as EaLocalDateTime,
        },
        with: [
          {
            kind: "working-plan",
            date: d,
            source: "plan",
            exceptionId: null,
            startMinute: 9 * 60,
            endMinute: 19 * 60,
          },
        ],
      },
      {
        reason: "blocked-period",
        severity: "soft",
        message: "El estudio está cerrado: Fumigación.",
        window: {
          start: `${d} 19:00:00` as EaLocalDateTime,
          end: `${d} 20:00:00` as EaLocalDateTime,
        },
        with: [
          {
            kind: "blocked-period",
            id: 60,
            name: "Fumigación",
            start: `${d} 19:00:00` as EaLocalDateTime,
            end: `${d} 20:00:00` as EaLocalDateTime,
          },
        ],
      },
      {
        reason: "provider-unavailable",
        severity: "soft",
        message: "La profesional marcó ese horario como no disponible.",
        window: {
          start: `${d} 16:00:00` as EaLocalDateTime,
          end: `${d} 18:00:00` as EaLocalDateTime,
        },
        with: [
          {
            kind: "unavailability",
            id: 40,
            providerId: 1,
            notes: "Cita médica",
            start: `${d} 16:00:00` as EaLocalDateTime,
            end: `${d} 18:00:00` as EaLocalDateTime,
          },
        ],
      },
    ],
  };
}
