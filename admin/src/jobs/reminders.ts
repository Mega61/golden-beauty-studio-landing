/**
 * A quién hay que mandarle recordatorio, y a quién no.
 *
 * Agenda Pro los manda hoy. El día que se cancele, si esto no corre, la clienta
 * deja de recibirlos y la inasistencia sube — es la regresión más visible del
 * corte y la única que la clienta nota sin que nadie se la cuente.
 *
 * ## Todo lo que decide está acá, y es puro
 *
 * El job que lo ejecuta lee citas, escribe filas y llama a Meta. Esa parte no
 * se puede testear sin red. Esta sí, y es donde viven las decisiones que se
 * pagan caro: mandar dos veces, mandar a quien pidió no recibir, o mandar un
 * recordatorio de una cita que ya pasó.
 *
 * ## Por qué hay una ventana y no un instante
 *
 * "Mandar 24 horas antes" suena a instante y no lo es: el job corre cada N
 * minutos, y una cita cuyo momento exacto cayó entre dos corridas no se
 * mandaría nunca. La ventana es `[objetivo − tolerancia, objetivo + tolerancia]`
 * y la tolerancia tiene que ser mayor que el intervalo del cron, o vuelve el
 * mismo hueco por otro camino.
 *
 * El borde tardío importa más que el temprano: **un recordatorio que llega
 * tarde sigue sirviendo; uno que llega después de la cita es ruido**, y por eso
 * nunca se manda para una cita que ya empezó, por más que la ventana lo
 * permitiera.
 */

import type { WaMessageKind } from "@/db/types";

/** Una cita, reducida a lo que decide si se le manda algo. */
export type ReminderAppointment = {
  eaAppointmentId: number;
  /** Instante de inicio. Ya convertido desde la hora de pared de EA. */
  startAt: Date;
  /** `null` = la clienta no tiene teléfono utilizable. */
  phoneE164: string | null;
  /** El `status` crudo de EA, tal como está en la fila. */
  status: string;
};

/** Lo que ya se decidió antes para esa cita, por tipo. */
export type ExistingMessage = {
  eaAppointmentId: number;
  kind: WaMessageKind;
};

export type ReminderRule = {
  kind: WaMessageKind;
  /** Cuántos minutos antes de la cita. */
  leadMinutes: number;
  /** Media ventana, en minutos. Tiene que superar el intervalo del cron. */
  toleranceMinutes: number;
};

/**
 * Las dos ventanas del estudio.
 *
 * El de 24 h es el que evita la inasistencia —da tiempo de reprogramar— y el de
 * 2 h es el que evita el olvido del mismo día. La tolerancia de 35 minutos
 * asume un cron cada 30: si el intervalo sube, esto sube con él.
 */
export const REMINDER_RULES: readonly ReminderRule[] = [
  { kind: "recordatorio_24h", leadMinutes: 24 * 60, toleranceMinutes: 35 },
  { kind: "recordatorio_2h", leadMinutes: 2 * 60, toleranceMinutes: 35 },
];

/**
 * Estados de EA con los que **sí** se manda recordatorio.
 *
 * Una cita cancelada no lleva aviso, obviamente. Una `completada` tampoco: ya
 * pasó. Se comparan normalizados, así que `"No asistió"` y `"no_asistio"` entran
 * por la misma puerta — la lista de estados es texto libre en EA y conviven dos
 * vocabularios mientras haya citas viejas.
 */
const SENDABLE = new Set(["reservada", "confirmada", "reprogramada", "booked", "confirmed", "rescheduled"]);

function statusKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export type ReminderDecision =
  | { action: "enviar"; appointment: ReminderAppointment; rule: ReminderRule }
  | {
      action: "omitir";
      appointment: ReminderAppointment;
      rule: ReminderRule;
      reason: SkipReason;
    };

export type SkipReason =
  | "sin-telefono"
  | "opt-out"
  | "estado-no-aplica"
  | "ya-existe"
  | "cita-ya-empezo"
  | "fuera-de-ventana";

/**
 * Qué mandar ahora.
 *
 * Devuelve **una decisión por cita y por regla**, incluidas las de omitir —
 * pero solo las que valen la pena registrar. `fuera-de-ventana` no se devuelve:
 * son casi todas las citas en casi toda corrida, y escribirlas llenaría la tabla
 * de filas que no significan nada. Las otras razones sí: son "esta clienta no
 * recibió aviso y hay un motivo", que es exactamente lo que alguien va a querer
 * saber cuando una clienta no llegue.
 */
export function planReminders(input: {
  appointments: readonly ReminderAppointment[];
  existing: readonly ExistingMessage[];
  /** Números que pidieron no recibir. Ya normalizados. */
  optedOut: ReadonlySet<string>;
  now: Date;
  rules?: readonly ReminderRule[];
}): ReminderDecision[] {
  const rules = input.rules ?? REMINDER_RULES;

  const already = new Set(
    input.existing.map((message) => `${message.eaAppointmentId}:${message.kind}`),
  );

  const decisions: ReminderDecision[] = [];

  for (const appointment of input.appointments) {
    for (const rule of rules) {
      const target = appointment.startAt.getTime() - rule.leadMinutes * 60_000;
      const delta = Math.abs(input.now.getTime() - target);

      // Fuera de ventana primero y en silencio: es el caso de casi todas las
      // citas en casi toda corrida, y registrar eso sería registrar ruido.
      if (delta > rule.toleranceMinutes * 60_000) continue;

      // Ya decidido antes. La UNIQUE de la tabla también lo impediría, pero
      // llegar hasta el INSERT para chocar convertiría cada corrida en una
      // ráfaga de errores de base esperados.
      if (already.has(`${appointment.eaAppointmentId}:${rule.kind}`)) {
        decisions.push({ action: "omitir", appointment, rule, reason: "ya-existe" });
        continue;
      }

      // Una cita que ya empezó no lleva recordatorio aunque la ventana lo
      // permita: llegar tarde sirve, llegar después de la cita es ruido — y
      // para la clienta, una molestia.
      if (appointment.startAt.getTime() <= input.now.getTime()) {
        decisions.push({ action: "omitir", appointment, rule, reason: "cita-ya-empezo" });
        continue;
      }

      if (!SENDABLE.has(statusKey(appointment.status))) {
        decisions.push({ action: "omitir", appointment, rule, reason: "estado-no-aplica" });
        continue;
      }

      if (appointment.phoneE164 === null) {
        decisions.push({ action: "omitir", appointment, rule, reason: "sin-telefono" });
        continue;
      }

      if (input.optedOut.has(appointment.phoneE164)) {
        decisions.push({ action: "omitir", appointment, rule, reason: "opt-out" });
        continue;
      }

      decisions.push({ action: "enviar", appointment, rule });
    }
  }

  return decisions;
}

/**
 * Cuándo debió salir el mensaje. Es lo que se guarda en `scheduled_for`.
 *
 * Se guarda el momento **objetivo**, no el de envío: es lo que deja ver después
 * si el cron se está atrasando, comparándolo contra `sent_at`. Guardar el de
 * envío en las dos columnas haría imposible notarlo.
 */
export function scheduledFor(appointment: ReminderAppointment, rule: ReminderRule): Date {
  return new Date(appointment.startAt.getTime() - rule.leadMinutes * 60_000);
}

/**
 * La tolerancia alcanza para el intervalo del cron.
 *
 * Se comprueba en un test y no en tiempo de ejecución porque es una propiedad de
 * la configuración, no del dato: si alguien baja la frecuencia del cron sin
 * subir la tolerancia, las citas empiezan a caer entre dos corridas y **nadie se
 * entera** — no hay error, simplemente no llegan los recordatorios.
 */
export function toleranceCoversInterval(
  rules: readonly ReminderRule[],
  cronIntervalMinutes: number,
): boolean {
  return rules.every((rule) => rule.toleranceMinutes > cronIntervalMinutes / 2);
}
