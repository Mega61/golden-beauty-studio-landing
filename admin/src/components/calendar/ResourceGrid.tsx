"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DayGrid, GridBand, GridColumn, GridEvent } from "@/lib/calendar-layout";
import type { EaLocalDate } from "@/lib/ea/datetime";
import { formatDateLong, formatHour12, formatTimeRange } from "../ui/format";
import { STATUS_META } from "../ui/status";
import styles from "./calendar.module.css";
import {
  columnHeight,
  dragDeltaMinutes,
  laneBox,
  minuteToPx,
  snapMinute,
  spanBox,
} from "./geometry";
import { serviceTint } from "./service-color";
import { mapEaStatus } from "./status-map";
import type { MetaIndex } from "./types";

/**
 * La grilla de recurso: columnas = profesionales, filas = tiempo.
 *
 * **Este componente no calcula layout.** `buildDayGrid()` de B3 ya resolvió
 * carriles, capas, recortes, citas ocultas y huérfanas; acá se multiplica por el
 * alto de una fila y se dibuja. Si hace falta una regla que el motor no expone,
 * se le pide al motor — no se recalcula acá, porque entonces habría dos
 * respuestas para la misma pregunta y solo una tendría tests.
 *
 * ## Una sola grilla para todos los días
 *
 * Con 3 días o Semana no hay una grilla por día: hay una sola con
 * `días × profesionales` columnas y un gutter compartido. Así las filas quedan
 * alineadas sin sincronizar scrolls y los encabezados pegajosos funcionan con
 * las reglas normales de `position: sticky`.
 *
 * ## Los tres gestos, y por qué son distintos
 *
 * - **Crear:** tocar un hueco. Los huecos son botones de verdad, uno por slot y
 *   por columna, con tabulador rotativo — 288 paradas antes de la primera cita
 *   sería peor que no tener teclado.
 * - **Mover en táctil:** tocar la cita → "Mover" → tocar el destino. Arrastrar
 *   sobre una grilla que scrollea es un modo de falla conocido.
 * - **Mover y redimensionar con puntero fino:** arrastre normal. La comprobación
 *   está en los dos lados —`@media (pointer: fine)` en la hoja y `matchMedia` acá—
 *   porque una media query no puede desactivar un `pointerdown`.
 */

export type SlotPick = {
  providerId: number;
  date: EaLocalDate;
  /** Minuto del día, ya ajustado a la rejilla. */
  minute: number;
};

export type MovePick = SlotPick & { appointment: GridEvent["appointment"] };

export type ResizePick = {
  appointment: GridEvent["appointment"];
  /** Nuevo fin, en minutos del día de la cita. */
  endMinute: number;
};

export type ResourceGridProps = {
  /** Un `DayGrid` por día visible, en orden y con el mismo rango. */
  days: readonly DayGrid[];
  meta: MetaIndex;
  /** Alto de una fila, en píxeles. */
  slotHeight?: number;
  /** Hoy, para marcar la columna del día. */
  today: EaLocalDate;
  /** La cita abierta en el panel. */
  selectedId?: number | null;
  /** La cita armada para moverse en táctil. */
  movingId?: number | null;
  /** Citas cuyo PUT está en vuelo: se dibujan con filete discontinuo. */
  pendingIds?: readonly number[];
  /** Solo lectura: EA no responde, o el rol no alcanza. */
  readOnly?: boolean;
  onPickSlot: (pick: SlotPick) => void;
  onPickAppointment: (appointment: GridEvent["appointment"]) => void;
  onMove: (pick: MovePick) => void;
  onResize: (pick: ResizePick) => void;
  /** Correr el inicio o el fin de la jornada visible para descubrir una oculta. */
  onRevealHidden: (direction: -1 | 1) => void;
};

/** Alto de fila por defecto: 14 px por 15 minutos ≈ 670 px de jornada. */
const DEFAULT_SLOT_H = 14;

/** Debajo de esto un bloque solo muestra la hora; no cabe otra línea. */
const TWO_LINE_MIN_PX = 30;
const THREE_LINE_MIN_PX = 46;

type ColumnKey = string;

function columnKey(date: EaLocalDate, providerId: number): ColumnKey {
  return `${date}#${providerId}`;
}

type DragState = {
  kind: "move" | "resize";
  appointment: GridEvent["appointment"];
  /** Minuto de inicio original, en el día de su columna. */
  startMinute: number;
  endMinute: number;
  pointerId: number;
  originY: number;
  /** Desplazamiento vivo, ya ajustado a la rejilla. */
  deltaMinutes: number;
  /** Columna bajo el puntero. */
  overKey: ColumnKey;
};

export function ResourceGrid({
  days,
  meta,
  slotHeight = DEFAULT_SLOT_H,
  today,
  selectedId = null,
  movingId = null,
  pendingIds,
  readOnly = false,
  onPickSlot,
  onPickAppointment,
  onMove,
  onResize,
  onRevealHidden,
}: ResourceGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canDrag, setCanDrag] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [activeSlot, setActiveSlot] = useState<{ key: ColumnKey; minute: number } | null>(null);
  const scrolledFor = useRef<string>("");

  const range = days[0]?.range;
  const pending = useMemo(() => new Set(pendingIds ?? []), [pendingIds]);

  // El espejo en JS de `@media (pointer: fine)`. Se escucha el cambio porque un
  // convertible pasa de táctil a ratón sin recargar la página.
  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const sync = () => setCanDrag(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Scroll inicial anclado al comienzo de la jornada, no a medianoche. Se hace
  // una vez por combinación de días: al cambiar de fecha la grilla vuelve
  // arriba, pero mientras se mira el mismo día un refresco de polling no puede
  // arrancarle el scroll de las manos a quien está leyendo.
  const dayKey = days.map((d) => d.date).join(",");
  useEffect(() => {
    if (scrolledFor.current === dayKey) return;
    scrolledFor.current = dayKey;
    scroller.current?.scrollTo({ top: 0, left: 0 });
  }, [dayKey]);

  const finishDrag = useCallback(
    (state: DragState) => {
      const [date, providerRaw] = state.overKey.split("#");
      const providerId = Number(providerRaw);

      if (state.kind === "resize") {
        const end = state.endMinute + state.deltaMinutes;
        // Un arrastre que deja el fin en o antes del inicio no es una cita de
        // duración cero: es un gesto fallido. Se descarta en vez de mandarle a
        // EA algo que después habría que explicar.
        if (end > state.startMinute) onResize({ appointment: state.appointment, endMinute: end });
        return;
      }

      const minute = state.startMinute + state.deltaMinutes;
      const moved = minute !== state.startMinute || providerId !== state.appointment.providerId;
      if (moved) {
        onMove({
          appointment: state.appointment,
          providerId,
          date: date as EaLocalDate,
          minute,
        });
      }
    },
    [onMove, onResize],
  );

  // El arrastre se sigue en la ventana, no en el bloque: soltar fuera de la
  // grilla tiene que terminar el gesto igual, y sin esto el bloque se quedaría
  // pegado al puntero.
  useEffect(() => {
    if (!drag || !range) return;

    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const delta = dragDeltaMinutes(event.clientY - drag.originY, range, slotHeight);
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const col = target?.closest<HTMLElement>("[data-colkey]");
      const overKey = drag.kind === "move" ? (col?.dataset.colkey ?? drag.overKey) : drag.overKey;
      if (delta === drag.deltaMinutes && overKey === drag.overKey) return;
      setDrag({ ...drag, deltaMinutes: delta, overKey });
    };

    const up = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      finishDrag(drag);
      setDrag(null);
    };

    const cancel = () => setDrag(null);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [drag, range, slotHeight, finishDrag]);

  if (!range) return null;

  const bodyHeight = columnHeight(days[0].rowCount, slotHeight);
  const hourHeight = (60 / range.slotMinutes) * slotHeight;
  const columns = days.flatMap((day) =>
    day.columns.map((column) => ({ day, column, key: columnKey(day.date, column.providerId) })),
  );

  // Dónde arranca cada día dentro de la grilla, acumulando. No se multiplica el
  // índice del día por el número de columnas: los días comparten la lista de
  // profesionales hoy, pero el día que una técnica no trabaje y su columna no
  // se dibuje, la multiplicación desalinearía todos los encabezados siguientes
  // sin que nada falle a la vista.
  const dayOffsets: number[] = [];
  days.reduce((offset, day) => {
    dayOffsets.push(offset);
    return offset + day.columns.length;
  }, 0);

  /**
   * Flechas entre huecos. El foco se mueve por la rejilla, no por el DOM: la
   * metáfora de grilla no le sirve a un lector de pantalla, pero a quien teclea
   * con una mano y sostiene el teléfono con la otra sí.
   */
  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
    if (!slot) return;

    const key = slot.dataset.colkey as ColumnKey;
    const minute = Number(slot.dataset.minute);
    const index = columns.findIndex((c) => c.key === key);
    if (index === -1) return;

    let nextKey = key;
    let nextMinute = minute;

    switch (event.key) {
      case "ArrowDown":
        nextMinute = snapMinute(minute + range.slotMinutes, range);
        break;
      case "ArrowUp":
        nextMinute = snapMinute(minute - range.slotMinutes, range);
        break;
      case "ArrowRight":
        nextKey = columns[Math.min(columns.length - 1, index + 1)].key;
        break;
      case "ArrowLeft":
        nextKey = columns[Math.max(0, index - 1)].key;
        break;
      case "Home":
        nextMinute = range.startMinute;
        break;
      case "End":
        nextMinute = snapMinute(range.endMinute, range);
        break;
      default:
        return;
    }

    event.preventDefault();
    setActiveSlot({ key: nextKey, minute: nextMinute });
    const selector = `[data-slot][data-colkey="${nextKey}"][data-minute="${nextMinute}"]`;
    scroller.current?.querySelector<HTMLElement>(selector)?.focus();
  };

  const slotMinutes: number[] = [];
  for (let i = 0; i < days[0].rowCount; i += 1) {
    slotMinutes.push(range.startMinute + i * range.slotMinutes);
  }

  return (
    <div
      className={styles.scroller}
      ref={scroller}
      onKeyDown={onGridKeyDown}
      aria-label="Agenda por profesional"
    >
      <div
        className={styles.grid}
        style={
          {
            "--cols": columns.length,
            "--slot-h": `${slotHeight}px`,
            "--hour-h": `${hourHeight}px`,
          } as React.CSSProperties
        }
      >
        {/* Esquinas del gutter. Dos, porque hay dos filas pegajosas: la del día
            y la de la profesional. */}
        <div className={`${styles.corner} ${styles.cornerTop}`} style={{ gridColumn: 1 }} />
        <div className={`${styles.corner} ${styles.cornerMid}`} style={{ gridColumn: 1 }} />

        {days.map((day, dayIndex) => (
          <div
            key={`day-${day.date}`}
            className={`${styles.dayHead}${day.date === today ? ` ${styles.dayHeadToday}` : ""}`}
            style={{
              gridRow: 1,
              gridColumn: `${2 + dayOffsets[dayIndex]} / span ${Math.max(1, day.columns.length)}`,
            }}
          >
            {formatDateLong(`${day.date} 00:00:00`)}
          </div>
        ))}

        {columns.map(({ column, key }) => (
          <div
            key={`head-${key}`}
            className={styles.provHead}
            style={{ gridRow: 2 }}
            aria-current={selectedIsIn(column, selectedId) ? "true" : undefined}
          >
            <span className={styles.provName}>{column.providerName}</span>
            <span className={styles.provMeta}>{windowLabel(column)}</span>
          </div>
        ))}

        {/* Gutter de horas. Solo se etiquetan las horas en punto; el meridiano
            se escribe siempre porque una jornada de 8 a 20 cruza el mediodía y
            "8" a secas es ambiguo en una hoja impresa. */}
        <div className={styles.gutter} style={{ height: bodyHeight }}>
          {slotMinutes
            .filter((minute) => minute % 60 === 0)
            .map((minute) => (
              <span
                key={minute}
                className={`${styles.gutterMark}${
                  minute === range.startMinute ? ` ${styles.gutterMarkFirst}` : ""
                }`}
                style={{ top: minuteToPx(minute, range, slotHeight) }}
              >
                {formatHour12(Math.floor(minute / 60), minute % 60)}
              </span>
            ))}
        </div>

        {columns.map(({ day, column, key }) => {
          const isTarget = movingId !== null;
          return (
            <div
              key={`col-${key}`}
              data-colkey={key}
              className={[
                styles.col,
                isTarget ? styles.colTarget : "",
                selectedIsIn(column, selectedId) ? styles.colSelected : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ height: bodyHeight }}
            >
              {/* Huecos. Van primero para quedar debajo de todo: una banda de
                  bloqueo no debe robarle el clic al hueco — tocarlo abre el
                  panel y el motor de choques avisa que está bloqueado, que es
                  mejor que un hueco que no responde y no explica por qué. */}
              {!readOnly &&
                slotMinutes.map((minute) => (
                  <button
                    key={minute}
                    type="button"
                    data-slot
                    data-colkey={key}
                    data-minute={minute}
                    className={styles.slot}
                    style={{ top: minuteToPx(minute, range, slotHeight), height: slotHeight }}
                    tabIndex={isActive(activeSlot, key, minute, columns[0]?.key, range.startMinute) ? 0 : -1}
                    onFocus={() => setActiveSlot({ key, minute })}
                    onClick={() =>
                      onPickSlot({ providerId: column.providerId, date: day.date, minute })
                    }
                    aria-label={`${column.providerName}, ${formatHour12(
                      Math.floor(minute / 60),
                      minute % 60,
                    )} — hueco libre`}
                  />
                ))}

              {column.bands.map((band) => (
                <Band key={band.key} band={band} range={range} slotHeight={slotHeight} />
              ))}

              {column.events.map((event) => (
                <EventBlock
                  key={event.key}
                  event={event}
                  meta={meta[event.appointment.id]}
                  range={range}
                  slotHeight={slotHeight}
                  drag={drag}
                  colKey={key}
                  canDrag={canDrag && !readOnly}
                  selected={event.appointment.id === selectedId}
                  moving={event.appointment.id === movingId}
                  pending={pending.has(event.appointment.id)}
                  onPick={() => onPickAppointment(event.appointment)}
                  onDragStart={(kind, pointerId, originY) =>
                    setDrag({
                      kind,
                      appointment: event.appointment,
                      startMinute: event.startMinute,
                      endMinute: event.endMinute,
                      pointerId,
                      originY,
                      deltaMinutes: 0,
                      overKey: key,
                    })
                  }
                />
              ))}

              {column.hiddenBefore > 0 ? (
                <button
                  type="button"
                  className={`${styles.hidden} ${styles.hiddenTop}`}
                  onClick={() => onRevealHidden(-1)}
                >
                  ↑ {column.hiddenBefore}{" "}
                  {column.hiddenBefore === 1 ? "cita antes" : "citas antes"}
                </button>
              ) : null}

              {column.hiddenAfter > 0 ? (
                <button
                  type="button"
                  className={`${styles.hidden} ${styles.hiddenBottom}`}
                  onClick={() => onRevealHidden(1)}
                >
                  ↓ {column.hiddenAfter}{" "}
                  {column.hiddenAfter === 1 ? "cita después" : "citas después"}
                </button>
              ) : null}

              {day.nowLine ? (
                <div
                  className={styles.now}
                  style={{ top: minuteToPx(day.nowLine.minute, range, slotHeight) }}
                  aria-hidden
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

const BAND_CLASS: Record<GridBand["kind"], string> = {
  "off-hours": styles.bandOffHours,
  break: styles.bandBreak,
  blocked: styles.bandBlocked,
  unavailable: styles.bandUnavailable,
};

const BAND_TITLE: Record<GridBand["kind"], string> = {
  "off-hours": "Fuera del horario de la profesional",
  break: "Descanso",
  blocked: "El estudio está cerrado",
  unavailable: "La profesional no está disponible",
};

function Band({
  band,
  range,
  slotHeight,
}: {
  band: GridBand;
  range: DayGrid["range"];
  slotHeight: number;
}) {
  const box = spanBox(band.startMinute, band.endMinute, range, slotHeight);
  const label = band.label ?? (band.kind === "off-hours" ? null : BAND_TITLE[band.kind]);

  return (
    <div
      className={[
        styles.band,
        BAND_CLASS[band.kind],
        band.clippedStart ? styles.clippedTop : "",
        band.clippedEnd ? styles.clippedBottom : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ top: box.top, height: box.height }}
      title={BAND_TITLE[band.kind]}
    >
      {/* La etiqueta solo aparece si la banda tiene alto para ella. Una franja
          de un slot con texto encima es ilegible y tapa la cita de al lado. */}
      {label && box.height >= 20 ? <span className={styles.bandLabel}>{label}</span> : null}
    </div>
  );
}

function EventBlock({
  event,
  meta,
  range,
  slotHeight,
  drag,
  colKey,
  canDrag,
  selected,
  moving,
  pending,
  onPick,
  onDragStart,
}: {
  event: GridEvent;
  meta: MetaIndex[number] | undefined;
  range: DayGrid["range"];
  slotHeight: number;
  drag: DragState | null;
  colKey: ColumnKey;
  canDrag: boolean;
  selected: boolean;
  moving: boolean;
  pending: boolean;
  onPick: () => void;
  onDragStart: (kind: "move" | "resize", pointerId: number, originY: number) => void;
}) {
  const dragging = drag?.appointment.id === event.appointment.id;
  const shiftMinutes = dragging && drag.kind === "move" ? drag.deltaMinutes : 0;
  const growMinutes = dragging && drag.kind === "resize" ? drag.deltaMinutes : 0;

  const box = spanBox(
    event.startMinute + shiftMinutes,
    event.startMinute + shiftMinutes + event.renderHeightMinutes + growMinutes,
    range,
    slotHeight,
  );
  const lane = laneBox(event.offset, event.width);

  // Mientras se arrastra hacia otra columna, el bloque se pinta en la columna de
  // destino y desaparece de la de origen: sin eso el gesto no dice a dónde va.
  const homeless = dragging && drag.kind === "move" && drag.overKey !== colKey;

  const status = mapEaStatus(event.appointment.status);
  const statusMeta = STATUS_META[status];
  const tint = serviceTint(event.appointment.color ?? meta?.serviceColor ?? null);
  const who = meta?.customer ?? "Sin clienta";
  const what = meta?.service ?? "Sin servicio";
  const time = formatTimeRange(event.appointment.start, event.appointment.end);

  return (
    <button
      type="button"
      className={[
        styles.event,
        selected ? styles.eventSelected : "",
        moving ? styles.eventMoving : "",
        pending ? styles.eventPending : "",
        status === "desconocido" ? styles.eventUnknown : "",
        canDrag ? styles.eventDraggable : "",
        dragging ? styles.eventDragging : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          top: box.top,
          height: box.height,
          left: `${lane.leftPercent}%`,
          width: `${lane.widthPercent}%`,
          visibility: homeless ? "hidden" : undefined,
          "--ev-fill": tint.fill,
          "--ev-edge": tint.edge,
          "--ev-dot": `var(--color-st-${status}-dot)`,
        } as React.CSSProperties
      }
      onClick={onPick}
      onPointerDown={(pointerEvent) => {
        if (!canDrag || pointerEvent.button !== 0) return;
        onDragStart("move", pointerEvent.pointerId, pointerEvent.clientY);
      }}
      // El nombre accesible dice las cuatro cosas en texto: hora, clienta,
      // servicio y estado. Nunca color solo.
      aria-label={`${time} · ${who} · ${what} · ${statusMeta.label}`}
      title={`${time} · ${who} · ${what} · ${statusMeta.label}`}
      aria-pressed={selected || undefined}
    >
      {event.clippedStart || event.startsPreviousDay ? (
        <span className={styles.eventClipTop} aria-hidden>
          ▲
        </span>
      ) : null}

      <span className={styles.eventTime}>
        <span className={styles.eventDot} aria-hidden />
        {time}
      </span>

      {box.height >= TWO_LINE_MIN_PX ? <span className={styles.eventTitle}>{who}</span> : null}
      {box.height >= THREE_LINE_MIN_PX ? <span className={styles.eventSub}>{what}</span> : null}

      {event.clippedEnd || event.continuesNextDay ? (
        <span className={styles.eventClipBottom} aria-hidden>
          ▼
        </span>
      ) : null}

      {canDrag ? (
        <span
          className={styles.resize}
          role="presentation"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(pointerEvent) => {
            if (pointerEvent.button !== 0) return;
            pointerEvent.stopPropagation();
            onDragStart("resize", pointerEvent.pointerId, pointerEvent.clientY);
          }}
        />
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Utilidades de presentación
// ---------------------------------------------------------------------------

function windowLabel(column: GridColumn): string {
  const { startMinute, endMinute, source, exceptionId } = column.window;
  if (startMinute === null || endMinute === null) {
    return source === "plan-exception" ? "Día libre (excepción)" : "No trabaja";
  }
  const from = formatHour12(Math.floor(startMinute / 60), startMinute % 60);
  const till = formatHour12(Math.floor(endMinute / 60), endMinute % 60);
  return `${from} – ${till}${exceptionId !== null ? " · excepción" : ""}`;
}

function selectedIsIn(column: GridColumn, selectedId: number | null): boolean {
  if (selectedId === null) return false;
  return column.events.some((event) => event.appointment.id === selectedId);
}

/**
 * ¿Este hueco es el que recibe el tabulador?
 *
 * Uno solo por grilla. Mientras nadie haya movido el foco, es el primero de la
 * primera columna; después, el último que se tocó. Es el patrón de tabulador
 * rotativo, y sin él la grilla mete cientos de paradas antes de la primera cita.
 */
function isActive(
  active: { key: ColumnKey; minute: number } | null,
  key: ColumnKey,
  minute: number,
  firstKey: ColumnKey | undefined,
  firstMinute: number,
): boolean {
  if (active) return active.key === key && active.minute === minute;
  return key === firstKey && minute === firstMinute;
}
