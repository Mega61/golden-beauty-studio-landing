"use client";

import type { EaLocalDate } from "@/lib/ea/datetime";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { formatDateLong, formatDateShort } from "../ui/format";
import styles from "./calendar.module.css";
import {
  datesFor,
  RANGE_MODE_LABEL,
  RANGE_MODES,
  shiftAnchor,
  type AgendaView,
  type RangeMode,
} from "./range";

/**
 * El eje horizontal: atrás, hoy, adelante, y Día · 3 días · Semana.
 *
 * El selector es un grupo de **radios** disfrazado de segmentos, no tres
 * botones: la elección es excluyente y así el lector de pantalla puede decir
 * "2 de 3" en vez de leer tres botones sueltos sin relación entre sí.
 *
 * 3 días y Semana solo aparecen con barra lateral (≥1024 px) — § Contrato
 * responsive. Se esconde el **control**, no la vista: alguien que abra en el
 * celular un `?rango=semana` compartido desde el escritorio ve la semana, con
 * scroll. Una URL que deja de funcionar según el aparato es peor que un control
 * que no está.
 *
 * **En Lista los rangos se ven siempre**, también en el celular: una semana en
 * lista cabe en 390 px, y es justo para lo que existe la lista.
 */
export function RangeBar({
  mode,
  anchor,
  today,
  onMode,
  onAnchor,
  view = "grilla",
  onView,
  actions,
}: {
  mode: RangeMode;
  /** Grilla o lista. Sin `onView`, el selector no aparece. */
  view?: AgendaView;
  onView?: (view: AgendaView) => void;
  anchor: EaLocalDate;
  today: EaLocalDate;
  onMode: (mode: RangeMode) => void;
  onAnchor: (anchor: EaLocalDate) => void;
  /** Lo que la pantalla quiera colgar al final: Bloquear, Nueva cita, Imprimir. */
  actions?: React.ReactNode;
}) {
  const dates = datesFor(mode, anchor);
  const first = dates[0];
  const last = dates[dates.length - 1];

  const isToday = first === today || (first <= today && today <= last);
  const prevLabel = mode === "dia" ? "Día anterior" : "Días anteriores";
  const nextLabel = mode === "dia" ? "Día siguiente" : "Días siguientes";

  return (
    <div className={styles.bar}>
      {/* La fecha y cómo moverse, con la forma de `DateStepper`: flechas de
          44 px redondas y la fecha como titular de la fila. En el celular es
          la primera fila, entera; en escritorio va a la izquierda. */}
      <div className={styles.barNav}>
        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--icon ui-stepper__arrow"
          aria-label={prevLabel}
          title={prevLabel}
          onClick={() => onAnchor(shiftAnchor(mode, anchor, -1))}
        >
          <Icon name="chevron-izq" size={20} />
        </button>

        {/*
          La fecha, larga o corta según quepa. Dos nodos y no un `matchMedia`:
          el ancho lo decide CSS sin esperar a que hidrate, y sin arriesgar que
          el servidor pinte una y el navegador la otra.
        */}
        <span className={styles.barDate} aria-live="polite">
          <span className={styles.barDateLong}>
            {first === last
              ? capitalize(formatDateLong(`${first} 00:00:00`))
              : `${capitalize(formatDateLong(`${first} 00:00:00`))} – ${formatDateShort(`${last} 00:00:00`)}`}
          </span>
          <span className={styles.barDateShort}>
            {first === last
              ? capitalize(formatDateLong(`${first} 00:00:00`))
              : `${capitalize(formatDateShort(`${first} 00:00:00`))} – ${formatDateShort(`${last} 00:00:00`)}`}
          </span>
        </span>

        <button
          type="button"
          className="ui-btn ui-btn--secondary ui-btn--icon ui-stepper__arrow"
          aria-label={nextLabel}
          title={nextLabel}
          onClick={() => onAnchor(shiftAnchor(mode, anchor, 1))}
        >
          <Icon name="chevron-der" size={20} />
        </button>

        <Button
          size="sm"
          variant={isToday ? "ghost" : "secondary"}
          disabled={anchor === today}
          onClick={() => onAnchor(today)}
        >
          Hoy
        </Button>
      </div>

      <div className={styles.barTools}>
        {onView ? (
          <div className="ui-seg" role="radiogroup" aria-label="Vista de la agenda">
            {(["grilla", "lista"] as const).map((value) => (
              <label key={value} className="ui-seg__item">
                <input
                  type="radio"
                  name="vista"
                  value={value}
                  checked={view === value}
                  onChange={() => onView(value)}
                />
                {value === "grilla" ? "Grilla" : "Lista"}
              </label>
            ))}
          </div>
        ) : null}

        <div
          className={`ui-seg ${styles.modes}${view === "lista" ? ` ${styles.modesAlways}` : ""}`}
          role="radiogroup"
          aria-label="Rango de la agenda"
        >
          {RANGE_MODES.map((value) => (
            <label
              key={value}
              className={`ui-seg__item${value === "dia" ? "" : ` ${styles.modeWide}`}`}
            >
              <input
                type="radio"
                name="rango"
                value={value}
                checked={mode === value}
                onChange={() => onMode(value)}
              />
              {RANGE_MODE_LABEL[value]}
            </label>
          ))}
        </div>

        {actions}
      </div>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
