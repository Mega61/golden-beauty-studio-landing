/**
 * El color del servicio, convertido en algo que se puede poner debajo de texto.
 *
 * § Sistema visual reparte los dos canales de la cita: **el color del servicio
 * tiñe el bloque, el estado va en el borde y el punto**. Una profesional escanea
 * su columna y ve *qué tipo de trabajo* por tono y *en qué va* por el cromo.
 *
 * El problema es que el color que EA guarda no está pensado para eso. Su
 * default es `#7cbae8` a plena saturación, y cualquiera puede escribir `#000`
 * desde su interfaz. Un relleno así se come el texto del bloque: la etiqueta de
 * la cita mide 12 px y tiene que llegar a 4.5:1.
 *
 * Entonces no se pinta el color: se **mezcla** hacia el papel hasta dejarlo en
 * un tinte, igual que hacen los cinco tintes de estado de A3 (`#e3f1ff` es azul
 * a esa misma distancia). El tono sobrevive —que es todo lo que el canal tiene
 * que transportar— y la tinta de encima sigue siendo `--color-ink`.
 *
 * ## Por qué es una función pura y no `color-mix()` en el CSS
 *
 * Porque el número que hay que garantizar es el contraste, y un `color-mix()`
 * escrito en una hoja de estilos no se puede testear. Acá la mezcla se calcula,
 * y hay un test que toma el default de EA, el negro, el blanco y un puñado de
 * hexes torcidos y verifica que la tinta de cuerpo llega a 4.5:1 sobre el tinte
 * resultante en todos.
 *
 * ## Y el color por cita
 *
 * `Appointment.color` existe además del del servicio, y **gana**: es el que
 * alguien puso a mano sobre esa cita concreta. Es el mismo orden de precedencia
 * que usa el calendario de EA.
 */

import { contrastRatio } from "../ui/contrast";

/** El fondo contra el que se mezcla: `--color-paper`. */
const PAPER = "#fbf8f3";

/**
 * Cuánto del color original sobrevive en el relleno.
 *
 * 0.18 sale de igualar la distancia de los tintes de estado de A3: `#e3f1ff`
 * está a esa distancia de un azul saturado sobre papel. Más alto y el texto
 * empieza a pelear; más bajo y los servicios dejan de distinguirse entre sí.
 */
const FILL_MIX = 0.18;

/** El filete lleva más color: es una línea de 1 px y ahí 3:1 no aplica. */
const EDGE_MIX = 0.55;

export type ServiceTint = {
  /** Relleno del bloque. */
  fill: string;
  /** Filete de 1 px del mismo tono, un paso más saturado. */
  edge: string;
  /** `false` cuando no había color y se cayó al neutro. */
  fromService: boolean;
};

/** El tinte de una cita sin color de servicio: papel con un filete de sistema. */
export const NEUTRAL_TINT: ServiceTint = {
  fill: "#f6f2ea",
  edge: "#ded4c4",
  fromService: false,
};

/**
 * `"#7cbae8"` o `"#7CB"` → `[124, 186, 232]`. `null` para cualquier otra cosa.
 *
 * EA guarda el color como texto libre en una columna `varchar`: llega
 * `"#7cbae8"`, `"7cbae8"`, `""`, `"transparent"` y, en instalaciones viejas,
 * `null`. Todo lo que no sea un hex se trata como "no hay color", que es la
 * lectura honesta.
 */
export function parseHex(raw: string | null | undefined): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^#/, "");

  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    return [
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
    ];
  }

  if (/^[0-9a-fA-F]{6}$/.test(value)) {
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }

  return null;
}

function toHex(channel: number): string {
  return Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");
}

/** Mezcla lineal en sRGB. No es perceptual, y para un tinte no hace falta. */
function mix(color: [number, number, number], onto: [number, number, number], amount: number): string {
  return `#${color
    .map((channel, i) => toHex(channel * amount + onto[i] * (1 - amount)))
    .join("")}`;
}

/**
 * El tinte de un bloque a partir del color del servicio (o del de la cita).
 *
 * Sin color válido devuelve `NEUTRAL_TINT`: un bloque neutro con filete de
 * sistema. Nunca inventa un color a partir del id del servicio — un tono que no
 * viene de un dato es un tono que miente en cuanto alguien lo cambia en EA.
 */
export function serviceTint(raw: string | null | undefined): ServiceTint {
  const rgb = parseHex(raw);
  if (!rgb) return NEUTRAL_TINT;

  const paper = parseHex(PAPER) as [number, number, number];

  return {
    fill: mix(rgb, paper, FILL_MIX),
    edge: mix(rgb, paper, EDGE_MIX),
    fromService: true,
  };
}

/**
 * ¿Esta tinta se lee sobre este tinte?
 *
 * No se usa para decidir nada en tiempo de ejecución —el tinte ya está
 * calculado para que sí— sino para que el test lo verifique sobre una batería de
 * colores en vez de sobre el que a alguien se le ocurrió mirar.
 */
export function tintIsReadable(tint: ServiceTint, ink: string): boolean {
  return contrastRatio(ink, tint.fill) >= 4.5;
}
