import type { DayGrid } from "@/lib/calendar-layout";
import { formatDateLong, formatTimeRange } from "../ui/format";
import { STATUS_META } from "../ui/status";
import styles from "./calendar.module.css";
import { mapEaStatus } from "./status-map";
import type { MetaIndex } from "./types";

/**
 * La hoja de ruta del día: lo que la recepción pega en el mesón.
 *
 * **No es la grilla impresa.** Una grilla de bloques en absoluto sobre una
 * impresora láser sale como un tablero de manchas grises y se lleva media
 * resma. Lo que hace falta en papel es otra cosa: una columna por profesional,
 * las citas en orden, y el estado **en texto** — los tintes de la paleta no
 * sobreviven al blanco y negro, que es exactamente por qué la pastilla de A3
 * nunca deja apagar la etiqueta.
 *
 * Está siempre en el DOM y `display: none` en pantalla. Es más barato que una
 * ruta de impresión aparte y garantiza que lo que se imprime es lo que se está
 * viendo: no hay una segunda consulta que pueda traer otra cosa.
 */
export function DaySheet({
  days,
  meta,
  studio = "Golden Beauty Studio",
}: {
  days: readonly DayGrid[];
  meta: MetaIndex;
  studio?: string;
}) {
  return (
    <div className={styles.sheet}>
      {days.map((day) => (
        <section key={day.date} style={{ breakAfter: "page" }}>
          <header className={styles.sheetHead}>
            <div className={styles.sheetTitle}>{studio} · Hoja de ruta</div>
            <div className={styles.sheetDate}>{formatDateLong(`${day.date} 00:00:00`, true)}</div>
          </header>

          <div className={styles.sheetCols}>
            {day.columns.map((column) => (
              <div key={column.providerId} className={styles.sheetCol}>
                <div className={styles.sheetProv}>{column.providerName}</div>

                {column.events.length === 0 ? (
                  <div className={styles.sheetEmpty}>Sin citas.</div>
                ) : (
                  column.events.map((event) => {
                    const info = meta[event.appointment.id];
                    return (
                      <div key={event.key} className={styles.sheetItem}>
                        <span className={styles.sheetTime}>
                          {formatTimeRange(event.appointment.start, event.appointment.end)}
                        </span>
                        <span className={styles.sheetWho}>
                          {info?.customer ?? "Sin clienta"}
                          {info?.service ? ` — ${info.service}` : ""}
                        </span>
                        <span className={styles.sheetState}>
                          {STATUS_META[mapEaStatus(event.appointment.status)].label}
                        </span>
                      </div>
                    );
                  })
                )}

                {/* Lo que la jornada visible no alcanzó a mostrar sale también
                    en papel. Una cita que desaparece sin aviso es el peor modo
                    de falla de esta pantalla, y en el mesón todavía más: nadie
                    va a ir a comprobarlo contra el navegador. */}
                {column.hiddenBefore + column.hiddenAfter > 0 ? (
                  <div className={styles.sheetEmpty}>
                    Hay {column.hiddenBefore + column.hiddenAfter} cita(s) fuera del horario
                    mostrado.
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
