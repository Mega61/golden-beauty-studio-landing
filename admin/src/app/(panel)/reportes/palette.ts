/**
 * La instancia de paleta de gráficos del panel (WP-D4, con la skill `dataviz`).
 *
 * **No es una paleta nueva.** Son los mismos tonos que A3 fijó para los estados
 * de la cita en `globals.css`, reusados como slots de serie, porque el plan lo
 * dice así en § Sistema visual: "los mismos tonos alimentan después los
 * gráficos de reportes". El dashboard y la agenda tienen que leerse como un
 * solo sistema — si Reportes trajera su propia familia cromática, el verde de
 * "completada" en la agenda y el verde de la serie 3 en un gráfico serían dos
 * verdes distintos en la misma pantalla.
 *
 * ## Qué se midió, y con qué
 *
 * Todo lo de abajo salió del validador de `dataviz`
 * (`scripts/validate_palette.js`), corrido contra la superficie real de este
 * panel — `--color-paper` `#fbf8f3`, el fondo de `.ui-card` — y no contra la
 * superficie por defecto del skill. Los números:
 *
 * - **Categórica (4 slots)** — azul, rojo-naranja, verde, violeta. `--pairs all`
 *   (el gate duro, el que vale para dispersión y para todos-contra-todos):
 *   banda de L PASS, piso de croma PASS, peor par CVD ΔE **9.3** (deuteranopía,
 *   objetivo ≥8), peor par en visión normal ΔE **16.5** (piso 15), contraste
 *   ≥3:1 los cuatro. Sirve para cualquier forma de gráfico, no solo para pilas.
 * - **El quinto tono de la familia de estados —`reservada` `#544b43`— NO es un
 *   slot categórico.** Mide L 0.419 (fuera de la banda 0.43–0.77) y C 0.018
 *   (por debajo del piso 0.10): el validador lo reprueba dos veces, y con razón
 *   — a ese croma la piedra ya **lee como gris**. Se queda donde sí sirve: como
 *   el gris de de-énfasis, que es justo lo que la forma "emphasis" de `dataviz`
 *   necesita. Que un tono de la paleta de estados no sirva como serie no es una
 *   contradicción: en la pastilla lo acompañan un punto y una palabra, y en un
 *   gráfico de cinco series no habría ni punto ni palabra que lo salven.
 * - **Secuencial (magnitud)** — una sola familia, azul, seis pasos. Generada
 *   apuntando a valores de L en OKLCH sobre el tono del punto `confirmada`, y
 *   validada con `--ordinal`: L monótona PASS, ΔL adyacente ≥0.06 PASS, un solo
 *   tono (dispersión 1°) PASS. El paso más claro `#c4e2fe` mide 1.27:1 contra
 *   la superficie: eso es **legal en un mapa de calor** (el extremo claro
 *   significa "casi cero" y puede acercarse al fondo) y **no** en marcas
 *   ordinales discretas, donde el arranque es `#64b1f6` (2.16:1). Los dos usos
 *   están separados abajo a propósito.
 *
 *   **El salto de L 0.66 a 0.52 en el medio de la rampa no es un descuido.** La
 *   primera versión tenía siete pasos, espaciados regularmente, y el de L 0.58
 *   (`#307fc1`) resultó ser un **valle sin salida**: con tinta mide 3.67:1 y con
 *   blanco 4.26:1 — *ninguna de las dos alcanza 4.5:1*, así que no existía
 *   ninguna etiqueta legal dentro de una celda de ese paso. Saltarse esa franja
 *   de lightness deja los seis pasos con al menos una tinta que cumple, y el
 *   test de abajo lo verifica paso por paso en vez de confiar en que se vea
 *   bien. Lo encontró el test, no el ojo.
 * - **Estados** — los cinco tonos de `STATUS_HEX`, sin tocar, y **solo** para el
 *   estado de la cita. Un color de estado no hace de "serie 4" y una serie no
 *   hace de estado; es la regla de colisión de `dataviz` y acá se puede cumplir
 *   literalmente porque el dominio del estado existe de verdad.
 *
 * ## El dorado no aparece
 *
 * `--color-gold` es acción primaria, selección y anillo de foco, y el plan es
 * explícito: "**nunca** color que codifique un dato". Así que no hay slot
 * dorado, ni en la categórica ni en la rampa. Si algún día hace falta un quinto
 * slot, la salida es plegar la cola en "Otros" o partir en small multiples — no
 * inventar un tono.
 *
 * Este archivo no importa React ni `server-only`: lo leen el componente cliente
 * de los gráficos y su test.
 */

import { STATUS_HEX, type StatusToken } from "@/components/ui/status";

/** La superficie sobre la que se dibuja: el fondo de `.ui-card`. */
export const CHART_SURFACE = "#fbf8f3";

/**
 * Los cuatro slots categóricos, **en orden fijo**.
 *
 * El orden es el mecanismo de seguridad para daltonismo, no una preferencia
 * estética: se asignan en secuencia y **nunca se ciclan**. Una quinta serie no
 * recibe un tono generado — se pliega en "Otros" o el gráfico se parte en small
 * multiples.
 *
 * El color sigue a la **entidad**, no a su posición en el ranking. Filtrar una
 * técnica no puede repintar a las demás: quien aprendió que Lina es azul tiene
 * que seguir viéndola azul.
 */
export const SERIES = [
  STATUS_HEX.confirmada.dot, // #1f7fc8 azul
  STATUS_HEX["no-asistio"].dot, // #c8461f rojo-naranja
  STATUS_HEX.completada.dot, // #2f8a66 verde
  STATUS_HEX.cancelada.dot, // #6a3f9e violeta
] as const;

/** Cuántas series soporta la categórica antes de tener que plegar la cola. */
export const SERIES_CAP = SERIES.length;

/**
 * El gris de de-énfasis: el tono `reservada`, que no alcanza para identidad
 * pero es exactamente lo que la forma "emphasis" necesita para el fondo.
 */
export const DEEMPHASIS = STATUS_HEX.reservada.dot;

/**
 * El tono de un slot categórico. Cicla **a propósito no**: pedir el slot 5
 * devuelve el gris de de-énfasis, que se lee como "esto no es una serie
 * distinguible" en vez de repetir un azul y mentir.
 */
export function seriesColor(index: number): string {
  return SERIES[index] ?? DEEMPHASIS;
}

/**
 * La rampa secuencial completa, de claro a oscuro. **Solo para magnitud
 * continua** (mapas de calor): el paso 0 puede acercarse a la superficie porque
 * ahí significa "casi cero".
 */
export const SEQUENTIAL = [
  "#c4e2fe",
  "#92cafe",
  "#64b1f6",
  "#4a98db",
  "#196dad",
  "#00568e",
] as const;

/**
 * El primer paso legal para una marca **ordinal** discreta (barras por tramo,
 * escalones de un embudo): el extremo claro tiene que despegarse del fondo, y
 * `#c4e2fe` a 1.27:1 no lo hace. Índice 2 = `#64b1f6`, medido en 2.16:1.
 */
export const SEQUENTIAL_ORDINAL_START = 2;

/**
 * El paso de la rampa para un valor normalizado en `[0, 1]`.
 *
 * `null` (sin dato) **no es cero**: devuelve `null` y la celda se dibuja vacía
 * con filete punteado, no con el paso más claro. Un domingo cerrado y un
 * domingo con cero ocupación se ven distinto porque son cosas distintas — es la
 * misma decisión que `computeOccupancy()` toma al devolver `null` en vez de 0.
 */
export function sequentialStep(t: number | null): string | null {
  if (t === null || !Number.isFinite(t)) return null;
  const clamped = Math.min(1, Math.max(0, t));
  const index = Math.min(
    SEQUENTIAL.length - 1,
    Math.floor(clamped * SEQUENTIAL.length),
  );
  return SEQUENTIAL[index] ?? null;
}

/**
 * Tinta o blanco encima de un relleno de la rampa.
 *
 * Es la única excepción a "el texto nunca lleva el color del dato": una
 * etiqueta **dentro** de una celda teñida elige su tinta por la luminancia del
 * relleno. Los cortes están medidos, no estimados, con la fórmula de WCAG:
 *
 * | relleno   | `#2a221c` | `#ffffff` |
 * | --------- | --------- | --------- |
 * | `#c4e2fe` | 11.65:1   |           |
 * | `#92cafe` |  9.00:1   |           |
 * | `#64b1f6` |  6.82:1   |           |
 * | `#4a98db` |  5.06:1   |  3.09:1   |
 * | `#196dad` |           |  5.48:1   |
 * | `#00568e` |           |  7.72:1   |
 *
 * De ahí el corte en el índice 4: hasta el 3 gana la tinta (≥5.06:1), del 4 en
 * adelante el blanco (≥5.48:1). Ningún par baja de 4.5:1 — y llegar a eso fue
 * lo que obligó a saltarse la franja de L 0.58, ver arriba.
 */
export const SEQUENTIAL_INK_FLIP = 4;

export function inkOnSequential(step: string): string {
  const index = SEQUENTIAL.indexOf(step as (typeof SEQUENTIAL)[number]);
  return index >= SEQUENTIAL_INK_FLIP ? "#ffffff" : "#2a221c";
}

/** El tono del punto de un estado de cita. Para gráficos **de estado**. */
export function statusColor(token: StatusToken): string {
  return STATUS_HEX[token].dot;
}

/**
 * Cromo del gráfico. Sale de los tokens de A3, en hex, porque el degradado de
 * la grilla se arma como cadena en JavaScript y ahí no hay una `var()` que
 * resolver.
 *
 * **No hay token de gris `ink-mute` acá, a propósito.** Mide 3.91:1 sobre
 * marfil y A3 lo dice de frente: no alcanza para texto de cuerpo. La primera
 * versión de estos gráficos lo usaba para las marcas del eje y para la raya de
 * una celda sin dato —los dos son texto de 12 px— y las dos medidas salieron
 * en 3.91:1 al medirlas en el navegador. No tener el token es la forma de que
 * el error no se pueda repetir; el peso visual de un eje recesivo se baja con
 * el tamaño y con el filete, no con el contraste.
 */
export const CHROME = {
  /** Filete de la grilla: un paso off-surface, sólido, 1 px. */
  grid: "rgba(28, 23, 20, 0.12)",
  /** Filete del eje, un paso más marcado que la grilla. */
  axis: "rgba(28, 23, 20, 0.2)",
  ink: "#2a221c",
  inkSoft: "#5b4a3a",
  surface: CHART_SURFACE,
} as const;
