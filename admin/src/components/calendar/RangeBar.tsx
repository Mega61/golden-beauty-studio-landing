"use client";

import type { EaLocalDate } from "@/lib/ea/datetime";
import { Button } from "../ui/Button";
import { formatDateLong, formatDateShort } from "../ui/format";
import styles from "./calendar.module.css";
import {
  datesFor,
  RANGE_MODE_LABEL,
  RANGE_MODES,
  shiftAnchor,
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
 */
export function RangeBar({
  mode,
  anchor,
  today,
  onMode,
  onAnchor,
  actions,
}: {
  mode: RangeMode;
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

  return (
    <div className={styles.bar}>
      <Button
        icon="chevron-izq"
        size="sm"
        variant="ghost"
        aria-label="Días anteriores"
        onClick={() => onAnchor(shiftAnchor(mode, anchor, -1))}
      />
      <Button
        icon="chevron-der"
        size="sm"
        variant="ghost"
        aria-label="Días siguientes"
        onClick={() => onAnchor(shiftAnchor(mode, anchor, 1))}
      />
      <Button
        size="sm"
        variant={anchor === today ? "primary" : "secondary"}
        onClick={() => onAnchor(today)}
      >
        Hoy
      </Button>

      <span className={styles.barDate}>
        {first === last
          ? capitalize(formatDateLong(`${first} 00:00:00`))
          : `${capitalize(formatDateLong(`${first} 00:00:00`))} – ${formatDateShort(`${last} 00:00:00`)}`}
      </span>

      <div className={styles.modes} role="radiogroup" aria-label="Rango de la agenda">
        {RANGE_MODES.map((value) => (
          <label
            key={value}
            className={`${styles.mode}${value === "dia" ? "" : ` ${styles.modeWide}`}`}
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
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
