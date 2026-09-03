/**
 * "Bloqueos": un botón, un formulario, y **tres recursos de EA por debajo**.
 *
 * EA expone tres cosas que hacen casi lo mismo y obliga a saber cuál usar:
 * `blocked_periods` (todo el estudio), `unavailabilities` (una técnica, un
 * rato) y `working_plan_exceptions` (una técnica, otro horario). El panel no
 * pregunta por el recurso; pregunta **quién** y **cuándo**, y elige. Es una de
 * las pocas partes donde el panel es estrictamente mejor que EA, y sale casi
 * gratis — a cambio de que la elección viva en una función pura y testeada, en
 * vez de en tres ramas dentro de un `onSubmit`.
 *
 * | Lo que la usuaria quiere                        | Recurso                   |
 * | ----------------------------------------------- | ------------------------- |
 * | El estudio cierra el 25 y 26 de diciembre       | `blocked_periods`         |
 * | Lina no está el martes de 2 a 4                 | `unavailabilities`        |
 * | Lina el jueves entra a las 11 en vez de a las 9 | `working_plan_exceptions` |
 *
 * ## Tres decisiones que el plan no fijaba
 *
 * - **Un registro por día, no uno que abarque el rango.** "Lina no está martes
 *   y miércoles de 2 a 4" son dos indisponibilidades de dos horas, no una de
 *   cuarenta y ocho: un solo registro tapando dos noches diría que tampoco está
 *   el martes a medianoche, y peor, `conflict.ts` lo leería así. El único que
 *   sí abarca el rango es `blocked_periods`, porque el estudio cerrado **está**
 *   cerrado también de noche.
 * - **El día libre es una excepción de plan, no una indisponibilidad de 24 h.**
 *   Las dos "funcionan", pero solo la excepción hace que EA deje de ofrecer
 *   horas de esa técnica en el booking, y solo ella se ve como día libre en la
 *   grilla en vez de como una franja gris encima de una jornada que sigue
 *   dibujada.
 * - **El formulario valida antes de elegir.** Un rango invertido, una hora sin
 *   la otra o una técnica sin elegir devuelven errores con el nombre del campo,
 *   no un `throw`: § Piso de accesibilidad pide resumen de errores al enviar un
 *   formulario largo, y para eso hace falta la lista completa, no el primero.
 */

import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea/datetime";
import { parsePlanTime } from "@/lib/calendar-layout";
import type {
  BlockedPeriodInput,
  UnavailabilityInput,
  WorkingPlanExceptionInput,
} from "@/lib/ea/types";

/** A quién afecta. Es la primera pregunta del formulario y la que más decide. */
export type BlockScope = "estudio" | "profesional";

/**
 * Qué le pasa a la técnica.
 *
 * - `ausencia` — no está en ese rato. Su jornada sigue siendo la de siempre.
 * - `horario` — ese día trabaja en otro horario, o no trabaja.
 */
export type BlockKind = "ausencia" | "horario";

export type BlockForm = {
  scope: BlockScope;
  /** Obligatorio cuando `scope` es `profesional`. */
  providerId: number | null;
  kind: BlockKind;
  startDate: EaLocalDate;
  /** Igual a `startDate` para un solo día. */
  endDate: EaLocalDate;
  /**
   * Todo el día. Con `kind: "horario"` significa **día libre**, que es distinto
   * de una ausencia de 24 h; ver la cabecera.
   */
  allDay: boolean;
  /** `"HH:MM"`. Se ignora con `allDay`. */
  startTime: string | null;
  endTime: string | null;
  /** Motivo. Va al `name` del bloqueo o a las `notes` de la indisponibilidad. */
  reason: string;
};

/** Qué recurso de EA hay que escribir, y con qué cuerpo. */
export type BlockPlan =
  | { resource: "blocked_periods"; inputs: BlockedPeriodInput[] }
  | { resource: "unavailabilities"; inputs: UnavailabilityInput[] }
  | { resource: "working_plan_exceptions"; inputs: WorkingPlanExceptionInput[] };

/** Un error de formulario, atado al campo que lo produce. */
export type BlockFieldError = { field: keyof BlockForm; message: string };

export type BlockPlanResult =
  | { ok: true; plan: BlockPlan; days: number }
  | { ok: false; errors: BlockFieldError[] };

/**
 * Cómo se llama cada recurso en pantalla, en singular y en plural.
 *
 * La usuaria nunca lee el nombre técnico. El plural va escrito y no derivado
 * con una `s`: "ausencia de la profesional" pluraliza por la primera palabra,
 * y una función que agregue la letra al final produce basura en español.
 */
export const BLOCK_RESOURCE_LABEL: Readonly<
  Record<BlockPlan["resource"], { one: string; many: string }>
> = {
  blocked_periods: { one: "cierre del estudio", many: "cierres del estudio" },
  unavailabilities: {
    one: "ausencia de la profesional",
    many: "ausencias de la profesional",
  },
  working_plan_exceptions: { one: "horario excepcional", many: "horarios excepcionales" },
};

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Aritmética de calendario pura, igual que en `range.ts`. Ver ahí el porqué. */
function nextDay(date: EaLocalDate): EaLocalDate {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) as EaLocalDate;
}

/** Los días del rango, inclusive. El tope de 366 es una guarda, no una regla. */
function daysBetween(from: EaLocalDate, till: EaLocalDate): EaLocalDate[] {
  const out: EaLocalDate[] = [];
  let cursor = from;
  for (let i = 0; i < 366 && cursor <= till; i += 1) {
    out.push(cursor);
    cursor = nextDay(cursor);
  }
  return out;
}

function at(date: EaLocalDate, time: string): EaLocalDateTime {
  return `${date} ${time.length === 5 ? `${time}:00` : time}` as EaLocalDateTime;
}

/**
 * El final de un día completo.
 *
 * `23:59:59` y no la medianoche siguiente: el solape de `conflict.ts` es
 * estricto (`start < end && end > start`), así que un bloqueo que terminara a
 * las 00:00:00 del día siguiente no chocaría con una cita que empieza a esa
 * misma hora — pero **sí** aparecería tapando el primer minuto del día
 * siguiente en la grilla. Un segundo antes evita las dos cosas.
 */
function endOfDay(date: EaLocalDate): EaLocalDateTime {
  return `${date} 23:59:59` as EaLocalDateTime;
}

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

/**
 * Valida el formulario y decide qué recurso de EA se escribe.
 *
 * Devuelve **todos** los errores, no el primero: el resumen de errores del
 * formulario los enumera y cada línea es un enlace al campo.
 */
export function planBlock(form: BlockForm): BlockPlanResult {
  const errors: BlockFieldError[] = [];

  if (!DATE_RE.test(form.startDate)) {
    errors.push({ field: "startDate", message: "Elige la fecha de inicio." });
  }
  if (!DATE_RE.test(form.endDate)) {
    errors.push({ field: "endDate", message: "Elige la fecha de fin." });
  }
  if (DATE_RE.test(form.startDate) && DATE_RE.test(form.endDate) && form.endDate < form.startDate) {
    errors.push({ field: "endDate", message: "El fin no puede ser antes del inicio." });
  }
  if (form.scope === "profesional" && form.providerId === null) {
    errors.push({ field: "providerId", message: "Elige a quién le aplica." });
  }

  // Las horas solo se validan cuando hacen falta. Con `allDay` puesto, un campo
  // de hora a medio escribir no tiene por qué frenar el envío: no se va a usar.
  let startMinute: number | null = null;
  let endMinute: number | null = null;

  if (!form.allDay) {
    startMinute = parsePlanTime(form.startTime);
    endMinute = parsePlanTime(form.endTime);

    if (startMinute === null) {
      errors.push({ field: "startTime", message: "Escribe la hora de inicio." });
    }
    if (endMinute === null) {
      errors.push({ field: "endTime", message: "Escribe la hora de fin." });
    }
    if (startMinute !== null && endMinute !== null && endMinute <= startMinute) {
      errors.push({ field: "endTime", message: "La hora de fin tiene que ser posterior." });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const days = daysBetween(form.startDate, form.endDate);
  const reason = form.reason.trim();
  const from = form.allDay ? "00:00" : (form.startTime as string);
  const till = form.allDay ? null : (form.endTime as string);

  // ── El estudio cierra ────────────────────────────────────────────────────
  //
  // Un solo registro que abarca el rango completo, de la primera hora del
  // primer día a la última del último. El estudio cerrado lo está también de
  // noche, así que partirlo por día sería inventar huecos abiertos a las 3 de
  // la mañana.
  if (form.scope === "estudio") {
    return {
      ok: true,
      days: days.length,
      plan: {
        resource: "blocked_periods",
        inputs: [
          {
            name: reason === "" ? "Cerrado" : reason,
            start: at(days[0], from),
            end: till === null ? endOfDay(days[days.length - 1]) : at(days[days.length - 1], till),
            notes: null,
          },
        ],
      },
    };
  }

  // ── La técnica trabaja en otro horario (o no trabaja) ────────────────────
  //
  // Una excepción por día. EA acepta un rango en `startDate`/`endDate`, pero un
  // solo registro para "el jueves y el viernes entro a las 11" es indistinguible
  // de dos, y dos se pueden borrar por separado — que es lo que la usuaria va a
  // querer el día que solo cambie el viernes.
  if (form.kind === "horario") {
    return {
      ok: true,
      days: days.length,
      plan: {
        resource: "working_plan_exceptions",
        inputs: days.map((date) => ({
          startDate: date,
          endDate: date,
          // `null` en las dos horas es **día libre**, y ese null es información
          // (ver `WorkingPlanException` en A1).
          startTime: form.allDay ? null : from,
          endTime: form.allDay ? null : (till as string),
          breaks: [],
          providerId: form.providerId,
        })),
      },
    };
  }

  // ── La técnica no está en ese rato ───────────────────────────────────────
  //
  // Una indisponibilidad por día, del mismo tramo horario. Ver la cabecera:
  // un registro que abarcara varios días taparía también las noches.
  return {
    ok: true,
    days: days.length,
    plan: {
      resource: "unavailabilities",
      inputs: days.map((date) => ({
        start: at(date, from),
        end: till === null ? endOfDay(date) : at(date, till),
        notes: reason === "" ? null : reason,
        providerId: form.providerId,
      })),
    },
  };
}

/**
 * Cómo se lee en voz alta lo que se está por hacer, para confirmarlo antes de
 * escribirlo.
 *
 * Existe porque el formulario esconde a propósito cuál de los tres recursos se
 * va a tocar, y esconder no puede significar que la usuaria no sepa qué firmó.
 * Es la línea que el panel muestra debajo del botón: "Se van a crear 2
 * ausencias de la profesional."
 */
export function describePlan(plan: BlockPlan, days: number): string {
  if (plan.resource === "blocked_periods") {
    return days === 1
      ? "Se va a cerrar el estudio ese día."
      : `Se va a cerrar el estudio ${days} días seguidos.`;
  }

  const n = plan.inputs.length;
  const label = BLOCK_RESOURCE_LABEL[plan.resource];

  return n === 1
    ? `Se va a registrar 1 ${label.one}.`
    : `Se van a registrar ${n} ${label.many}.`;
}
