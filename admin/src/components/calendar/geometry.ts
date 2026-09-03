/**
 * De minutos a píxeles. Y nada más.
 *
 * `lib/calendar-layout.ts` (B3) ya resolvió **todo** el layout: carriles,
 * capas, recortes, ocultas y huérfanas. Lo único que queda para pintar es
 * multiplicar minutos por el alto de una fila, y eso es esto. Si alguna vez
 * hace falta acá una regla que decida *dónde va* un bloque —y no solo a cuántos
 * píxeles del borde— la regla está en el módulo equivocado: se le pide a B3.
 *
 * Está fuera del componente por la misma razón que el motor: la aritmética de
 * un calendario se rompe en los bordes (un bloque que empieza antes del rango,
 * uno de duración cero, un puntero soltado sobre el encabezado) y esos bordes
 * se fijan con tests, no arrastrando el ratón.
 */

import type { DayGridRange } from "@/lib/calendar-layout";

/** Caja de un bloque dentro de la columna, en píxeles desde su borde superior. */
export type Box = { top: number; height: number };

/** Lo que ocupa un carril, listo para `left` y `width` en porcentaje. */
export type LaneBox = { leftPercent: number; widthPercent: number };

/**
 * Alto de la columna entera. Es `rowCount × slotHeight` y no
 * `(fin − inicio) / slotMinutes × slotHeight`: la última fila puede sobrar
 * cuando el rango no es múltiplo del slot, y B3 ya redondeó hacia arriba en
 * `rowCount`. Calcularlo de nuevo acá sería la segunda fuente de verdad.
 */
export function columnHeight(rowCount: number, slotHeight: number): number {
  return rowCount * slotHeight;
}

/**
 * Minuto del día → píxeles desde el borde superior de la columna.
 *
 * No se recorta: un minuto anterior al rango da un número negativo, y eso es
 * correcto. Quien dibuja decide si lo recorta; B3 ya entrega los tramos
 * recortados con `clippedStart` / `clippedEnd` puestos.
 */
export function minuteToPx(
  minute: number,
  range: Pick<DayGridRange, "startMinute" | "slotMinutes">,
  slotHeight: number,
): number {
  return ((minute - range.startMinute) / range.slotMinutes) * slotHeight;
}

/** El inverso: píxeles desde el borde superior → minuto del día, sin ajustar. */
export function pxToMinute(
  px: number,
  range: Pick<DayGridRange, "startMinute" | "slotMinutes">,
  slotHeight: number,
): number {
  return range.startMinute + (px / slotHeight) * range.slotMinutes;
}

/**
 * La caja de un tramo `[startMinute, endMinute)`.
 *
 * El alto nunca baja de un píxel. Un bloque de alto cero no se puede tocar, no
 * se puede leer y equivale a haber perdido la cita — B3 ya trae
 * `renderHeightMinutes` para eso, pero las bandas no lo tienen y un descanso de
 * un minuto tiene que dejar rastro igual.
 */
export function spanBox(
  startMinute: number,
  endMinute: number,
  range: Pick<DayGridRange, "startMinute" | "slotMinutes">,
  slotHeight: number,
): Box {
  const top = minuteToPx(startMinute, range, slotHeight);
  const bottom = minuteToPx(endMinute, range, slotHeight);
  return { top, height: Math.max(1, bottom - top) };
}

/**
 * El ancho de un carril, con una canaleta entre bloques encimados.
 *
 * B3 entrega `offset` y `width` como fracciones exactas que suman 1. Si se
 * pintaran tal cual, dos citas encimadas quedarían pegadas y parecerían una
 * sola con una línea en medio. La canaleta se resta **del ancho**, no del
 * `left`, para que el borde izquierdo de cada carril siga cayendo donde el
 * motor dijo — que es lo que hace que la columna se lea como columnas.
 *
 * `gutterPercent` es un porcentaje del ancho de la columna, no del carril: con
 * seis carriles la canaleta tiene que seguir siendo la misma raya.
 */
export function laneBox(
  offset: number,
  width: number,
  gutterPercent = 1.5,
): LaneBox {
  const single = width >= 1;
  return {
    leftPercent: offset * 100,
    widthPercent: single ? 100 : Math.max(1, width * 100 - gutterPercent),
  };
}

/**
 * Ajusta un minuto a la rejilla del rango y lo deja dentro de la jornada.
 *
 * Es lo que convierte "solté el dedo a 143 px del borde" en "las 10:15". Se
 * redondea al slot **más cercano**, no hacia abajo: al arrastrar, el bloque
 * queda donde la persona lo ve, y redondear siempre hacia abajo produce el
 * medio slot de deriva que hace que nadie confíe en el gesto.
 *
 * El tope no es `endMinute` sino `endMinute − slotMinutes`: soltar en el último
 * píxel de la jornada tiene que crear una cita que empieza en el último hueco,
 * no una que empieza cuando el estudio ya cerró.
 */
export function snapMinute(minute: number, range: DayGridRange): number {
  const { startMinute, endMinute, slotMinutes } = range;
  const steps = Math.round((minute - startMinute) / slotMinutes);
  const snapped = startMinute + steps * slotMinutes;
  const last = Math.max(startMinute, endMinute - slotMinutes);
  return Math.min(last, Math.max(startMinute, snapped));
}

/**
 * Dónde cayó un puntero dentro de una columna → minuto ajustado.
 *
 * `offsetY` se mide contra la caja de la columna, no contra la ventana: la
 * grilla vive dentro de un contenedor que scrollea y usar coordenadas de página
 * es exactamente cómo se produce el bug de "la cita cae una hora más abajo
 * después de bajar la rueda".
 */
export function pointerMinute(
  offsetY: number,
  range: DayGridRange,
  slotHeight: number,
): number {
  return snapMinute(pxToMinute(offsetY, range, slotHeight), range);
}

/**
 * Cuánto dura, en minutos, arrastrar `deltaPx`. Ajustado a la rejilla y con
 * signo, para mover un bloque sin cambiarle la duración.
 */
export function dragDeltaMinutes(
  deltaPx: number,
  range: Pick<DayGridRange, "slotMinutes">,
  slotHeight: number,
): number {
  const raw = (deltaPx / slotHeight) * range.slotMinutes;
  return Math.round(raw / range.slotMinutes) * range.slotMinutes;
}
