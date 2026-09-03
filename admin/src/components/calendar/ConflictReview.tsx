"use client";

import type { Conflict, ConflictReport, ConflictSubject } from "@/lib/conflict";
import { formatHour12, formatTimeRange } from "../ui/format";
import { Icon } from "../ui/Icon";
import styles from "./calendar.module.css";
import type { MetaIndex, ProviderOption } from "./types";

/**
 * Qué choca, con qué, y el botón de "Guardar de todas formas".
 *
 * `checkConflicts()` de B3 no devuelve un booleano: devuelve motivos con
 * severidad, ventana y **sujetos**. Esto es lo que convierte esos sujetos en la
 * frase que el plan pide textualmente — "Lina ya tiene a Marcela de 2 a 3:30" —
 * sin volver a consultar nada.
 *
 * Los `message` que trae el motor son el texto por defecto y se usan tal cual:
 * están escritos en español y son los mismos que fijan sus tests. Lo que agrega
 * esta capa es la lista de con-qué, que el motor no puede escribir porque no
 * conoce los nombres — `ConflictSubject` trae ids, y traducir un
 * `providerId: 7` a "Lina" es de la pantalla.
 *
 * **Las dos severidades se pueden forzar.** EA solo tiene un `force_save` y no
 * distingue; la severidad cambia el tono y el orden, no la existencia del botón.
 * Un motor que impidiera guardar dejaría a la recepción sin salida frente a un
 * caso real y la empujaría a arreglarlo fuera del panel, que es donde el dato
 * deja de existir.
 */

export function ConflictReview({
  report,
  providers,
  meta,
}: {
  report: ConflictReport;
  providers: readonly ProviderOption[];
  meta: MetaIndex;
}) {
  if (report.ok) return null;

  const nameOf = (providerId: number | null): string =>
    providers.find((p) => p.id === providerId)?.name ?? "Otra profesional";

  return (
    <div className={styles.conflict}>
      <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
        {report.hard
          ? "Esto no debería poder pasar en el estudio. Revisa antes de guardar:"
          : "Se puede guardar, pero sale del horario previsto:"}
      </p>

      {report.conflicts.map((conflict, index) => (
        <div
          key={`${conflict.reason}-${index}`}
          className={`${styles.conflictItem} ${
            conflict.severity === "hard" ? styles.conflictHard : styles.conflictSoft
          }`}
        >
          <p className={styles.conflictHead}>
            <Icon name={conflict.severity === "hard" ? "alerta" : "info"} size={16} />
            {conflict.message}
          </p>

          {conflict.with.length > 0 ? (
            <ul className={styles.conflictWith}>
              {conflict.with.map((subject, i) => (
                <li key={i}>{describeSubject(subject, conflict, nameOf, meta)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Cierra la frase sin duplicar el punto.
 *
 * Las horas en español de Colombia terminan en `p. m.` — con punto. Concatenar
 * el punto de la oración produce `de 9 a 11:30 a. m..`, que es el tipo de
 * detalle que hace que una interfaz se lea como generada.
 */
function end(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * La frase de un sujeto.
 *
 * Cada variante de `ConflictSubject` dice algo distinto y ninguna se puede
 * escribir en genérico: "Lina ya tiene a Marcela de 2 a 3:30" y "faltó puesto:
 * 3 citas a la vez y 2 puestos" no comparten estructura. Por eso es un `switch`
 * exhaustivo y no una plantilla.
 */
function describeSubject(
  subject: ConflictSubject,
  conflict: Conflict,
  nameOf: (providerId: number | null) => string,
  meta: MetaIndex,
): string {
  switch (subject.kind) {
    case "appointment": {
      const who = meta[subject.id]?.customer ?? "una clienta";
      const when = formatTimeRange(subject.start, subject.end);
      // En el choque de columna el sujeto es de la misma técnica; en el de
      // puestos, de cualquiera. La frase nombra a la profesional en los dos
      // casos porque saber cuál es lo que permite ir a arreglarlo.
      return end(`${nameOf(subject.providerId)} ya tiene a ${who} de ${when}`);
    }

    case "unavailability": {
      const when = formatTimeRange(subject.start, subject.end);
      return subject.notes
        ? end(`Marcado como no disponible de ${when}: ${subject.notes}`)
        : end(`Marcado como no disponible de ${when}`);
    }

    case "blocked-period": {
      const when = formatTimeRange(subject.start, subject.end);
      return subject.name
        ? end(`El estudio está cerrado de ${when} — ${subject.name}`)
        : end(`El estudio está cerrado de ${when}`);
    }

    case "working-plan": {
      const origen = subject.source === "plan-exception" ? "la excepción de ese día" : "el plan";
      if (subject.startMinute === null || subject.endMinute === null) {
        return `Según ${origen}, ese día no trabaja.`;
      }
      const from = formatHour12(
        Math.floor(subject.startMinute / 60),
        subject.startMinute % 60,
      );
      const till = formatHour12(Math.floor(subject.endMinute / 60), subject.endMinute % 60);
      return end(`Según ${origen}, ese día trabaja de ${from} a ${till}`);
    }

    case "station": {
      const at = formatHour12(
        Number(subject.at.slice(11, 13)),
        Number(subject.at.slice(14, 16)),
      );
      return subject.total === 0
        ? "No hay puestos configurados en el estudio."
        : end(
            `A las ${at} habría ${subject.needed} citas a la vez y solo caben ${subject.seated} en los ${subject.total} puestos`,
          );
    }

    default: {
      // Un motivo nuevo en el motor no puede dejar la lista muda: se muestra el
      // mensaje que el propio motivo trae.
      return conflict.message;
    }
  }
}
