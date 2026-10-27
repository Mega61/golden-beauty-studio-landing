"use client";

import type { Appointment } from "@/lib/ea/types";
import type { EaLocalDate } from "@/lib/ea/datetime";
import { StatusPill } from "../ui/StatusPill";
import { WaSentLabels } from "../ui/WaSentLabels";
import { formatDateLong, formatDuration, formatTime } from "../ui/format";
import type { AgendaListDay } from "./agenda-list";
import styles from "./calendar.module.css";
import { serviceTint } from "./service-color";
import { mapEaStatus } from "./status-map";
import type { HistoryIndex, MetaIndex } from "./types";

/**
 * La agenda en lista, como la vista "Agenda" de Google Calendar: cada día con
 * sus citas en orden, y un toque abre el mismo detalle que en la grilla.
 *
 * Solo lectura a propósito: mover y estirar son gestos de la grilla, donde se
 * ve el hueco de destino. Desde acá se consulta, y desde el detalle se edita.
 */
export function AgendaList({
  days,
  meta,
  history,
  today,
  selectedId,
  onPickAppointment,
}: {
  days: readonly AgendaListDay[];
  meta: MetaIndex;
  history?: HistoryIndex;
  today: EaLocalDate;
  selectedId: number | null;
  onPickAppointment: (appointment: Appointment) => void;
}) {
  return (
    <div className={styles.list}>
      {days.map((day) => {
        const isToday = day.date === today;
        return (
          <section
            key={day.date}
            className={styles.listDay}
            aria-labelledby={`lista-${day.date}`}
            data-today={isToday || undefined}
          >
            <h2 id={`lista-${day.date}`} className={styles.listDayHead}>
              <span className={styles.listDayName}>
                {capitalize(formatDateLong(`${day.date} 00:00:00`))}
              </span>
              {isToday ? <span className={styles.listToday}>Hoy</span> : null}
              <span className={styles.listCount}>
                {day.rows.length === 0
                  ? ""
                  : day.rows.length === 1
                    ? "1 cita"
                    : `${day.rows.length} citas`}
              </span>
            </h2>

            {day.rows.length === 0 ? (
              <p className={styles.listEmpty}>Sin citas.</p>
            ) : (
              <ul className={styles.listRows}>
                {day.rows.map(({ appointment, providerName }) => {
                  const info = meta[appointment.id];
                  const past = history?.[appointment.id];
                  const tint = serviceTint(appointment.color ?? info?.serviceColor ?? null);
                  const minutes = lengthMinutes(appointment);
                  return (
                    <li key={appointment.id}>
                      <button
                        type="button"
                        className={styles.listRow}
                        aria-current={selectedId === appointment.id || undefined}
                        data-history={past ? "true" : undefined}
                        onClick={() => onPickAppointment(appointment)}
                        style={
                          {
                            "--ev-fill": tint.fill,
                            "--ev-edge": tint.edge,
                          } as React.CSSProperties
                        }
                      >
                        <span className={styles.listTime}>
                          <span className={styles.listStart}>{formatTime(appointment.start)}</span>
                          <span className={styles.listEnd}>{formatTime(appointment.end)}</span>
                        </span>
                        <span className={styles.listSwatch} aria-hidden="true" />
                        <span className={styles.listBody}>
                          <span className={styles.listWho}>{info?.customer ?? "Sin cliente"}</span>
                          <span className={styles.listWhat}>
                            {info?.service ?? "Sin servicio"}
                            {minutes > 0 ? (
                              <span className={styles.listProv}> · {formatDuration(minutes)}</span>
                            ) : null}
                            <span className={styles.listProv}> · {providerName}</span>
                          </span>
                          <WaSentLabels labels={info?.waSent} />
                        </span>
                        <span className={styles.listState}>
                          {past ? (
                            <span className={styles.listHistory}>
                              {past.source} · {past.statusLabel}
                            </span>
                          ) : (
                            <StatusPill status={mapEaStatus(appointment.status)} size="sm" />
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function lengthMinutes(appointment: Appointment): number {
  const from = toMinutes(appointment.start);
  const till = toMinutes(appointment.end);
  const sameDay = appointment.start.slice(0, 10) === appointment.end.slice(0, 10);
  return sameDay ? till - from : till + 24 * 60 - from;
}

function toMinutes(wall: string): number {
  return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
