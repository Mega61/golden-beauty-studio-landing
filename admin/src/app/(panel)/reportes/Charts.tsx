"use client";

/**
 * Las cuatro formas de gráfico que Reportes necesita, más el tile de KPI.
 *
 * ## Por qué son de cliente
 *
 * Solo por el tooltip. Todo lo demás —geometría, color, etiquetas, la tabla
 * gemela— se pinta en el servidor y funciona sin JavaScript: si el bundle no
 * carga, el reporte se lee igual, con la tabla y las etiquetas directas. El
 * `"use client"` compra la capa de hover y foco, que es lo único que necesita
 * un evento del navegador.
 *
 * ## Reglas de `dataviz` que están cableadas acá y conviene no deshacer
 *
 * - **La leyenda existe siempre con dos o más series, y nunca con una.** Con
 *   una serie el título ya dice qué se dibuja.
 * - **El texto nunca lleva el color del dato.** La identidad la carga la marca
 *   de al lado. La única excepción es una etiqueta *dentro* de un relleno, y
 *   ahí la tinta la elige `inkOnSequential()`, medida.
 * - **Toda forma tiene su gemela en tabla.** El tooltip realza; no es la única
 *   forma de leer un valor. Y el foco de teclado muestra lo mismo que el hover.
 * - **Nada de doble eje.** No hay un solo componente que acepte dos escalas: el
 *   caso "dos medidas de distinta magnitud" se resuelve con dos gráficos, y por
 *   eso `extrasReport` entrega el enganche y el monto por separado.
 * - **Un valor no se etiqueta en cada punto.** Las barras etiquetan su extremo
 *   —que es *el* valor de la fila, no un punto de una serie— y los tramos
 *   interiores de una apilada no etiquetan nada: su cifra va en la leyenda.
 *
 * ## Ninguna prop es una función
 *
 * El eje llega como `{ value, label }[]` ya formateado y el mapa de calor como
 * una matriz de celdas, no como un `cellOf(row, col)`. No es gusto: **una
 * función no cruza la frontera entre Server y Client Components** — React no
 * la puede serializar y el render falla. Formatear en el servidor tiene además
 * la ventaja de que el `Intl.NumberFormat` de COP corre una vez por reporte y
 * no una vez por celda en el navegador de la dueña.
 */

import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "@/components/ui";

import styles from "./charts.module.css";
import {
  CHROME,
  DEEMPHASIS,
  inkOnSequential,
  SEQUENTIAL,
  sequentialStep,
  seriesColor,
} from "./palette";
import {
  linearScale,
  MARK,
  niceTicks,
  sparklinePath,
  type Delta,
} from "./scale";

// ── Tooltip ─────────────────────────────────────────────────────────────────

type Tip = { x: number; y: number; value: string; label: string };

/**
 * Un tooltip por gráfico, posicionado en coordenadas de viewport.
 *
 * `position: fixed` y coordenadas del cliente en vez de posición relativa al
 * contenedor: el mapa de calor scrollea dentro de su caja y una tarjeta puede
 * estar dentro de un contenedor con `overflow`, donde un tooltip absoluto
 * quedaría recortado justo en el borde, que es donde más se necesita.
 */
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);

  const show = useCallback(
    (event: { currentTarget: Element }, value: string, label: string) => {
      const box = event.currentTarget.getBoundingClientRect();
      setTip({
        x: box.left + box.width / 2,
        y: box.top,
        value,
        label,
      });
    },
    [],
  );

  const hide = useCallback(() => setTip(null), []);

  const node =
    tip === null ? null : (
      <div className={styles.tip} role="presentation" style={{ left: tip.x, top: tip.y }}>
        <span className={styles.tipValue}>{tip.value}</span>
        <span className={styles.tipLabel}>{tip.label}</span>
      </div>
    );

  return { show, hide, node };
}

// ── Marco común ─────────────────────────────────────────────────────────────

export type LegendEntry = { label: string; color: string };

/**
 * El marco de un reporte: título, la decisión que habilita, leyenda, la figura
 * y la tabla gemela.
 *
 * `decision` no es decoración. § El set de reportes propio le pone a cada
 * reporte "la decisión que habilita", y el plan es explícito: "el que no
 * responda ninguna, no se construye". Tenerla en pantalla es lo que impide que
 * un reporte se vuelva un número decorativo sin que nadie lo note.
 */
export function ChartFrame({
  title,
  decision,
  legend,
  note,
  children,
  table,
  headerExtra,
}: {
  title: string;
  decision: string;
  /** Con dos o más entradas se dibuja; con una o ninguna, no. */
  legend?: readonly LegendEntry[];
  note?: { tone?: "warn" | "info"; text: ReactNode };
  children: ReactNode;
  table?: ReactNode;
  headerExtra?: ReactNode;
}) {
  const legendId = useId();
  const showLegend = (legend?.length ?? 0) >= 2;

  return (
    <section className="ui-card">
      <header className="ui-card__head">
        <h2 className="ui-card__title">{title}</h2>
        {headerExtra}
      </header>

      <div className={styles.frame} style={{ padding: "0.75rem 1rem 1rem" }}>
        <p className={styles.decision}>{decision}</p>

        {note ? (
          <p
            className={
              note.tone === "info" ? `${styles.note} ${styles["note--info"]}` : styles.note
            }
          >
            <Icon name={note.tone === "info" ? "info" : "alerta"} />
            <span>{note.text}</span>
          </p>
        ) : null}

        {showLegend ? (
          <ul className={styles.legend} id={legendId}>
            {legend?.map((entry) => (
              <li className={styles.legendItem} key={entry.label}>
                <span
                  aria-hidden="true"
                  className={styles.swatch}
                  style={{ background: entry.color }}
                />
                {entry.label}
              </li>
            ))}
          </ul>
        ) : null}

        <figure aria-describedby={showLegend ? legendId : undefined} className={styles.figure}>
          {children}
        </figure>

        {table ? (
          <details className={styles.tableToggle}>
            <summary>Ver la tabla</summary>
            <div className={styles.tableWrap}>{table}</div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

// ── Barras horizontales ─────────────────────────────────────────────────────

export type BarDatum = {
  /** Identidad de la fila. **El color sigue a esta llave, no al ranking.** */
  id: string;
  name: string;
  value: number;
  /** Cómo se escribe el valor: `"$ 120.000"`, `"31 %"`. */
  display: string;
  /** Segunda línea opcional: "12 cuentas", "150 min". */
  meta?: string;
  /**
   * Índice de slot categórico. Sin él todas las barras usan el slot 1, que es
   * lo correcto para categorías nominales: colorear cada barra por su valor
   * gastaría el canal de identidad en repetir lo que el largo ya dice.
   */
  seriesIndex?: number;
  /** `false` pinta la barra con el gris de de-énfasis (forma "emphasis"). */
  emphasis?: boolean;
};

/**
 * Barras horizontales, una serie.
 *
 * Horizontal y no vertical porque las categorías de este panel son nombres
 * largos —"Combo manos y pies"— y en columnas verticales terminarían rotados
 * 45°, que es el tell de un gráfico que no se pensó.
 *
 * `emphasis` implementa la forma que `dataviz` llama la más subutilizada: una
 * barra en el tono de acento y el resto en gris. Es la respuesta honesta a "el
 * reporte tiene ocho barras y la historia es una sola".
 */
export type AxisTick = { value: number; label: string };

/** Las marcas de eje de un reporte, ya formateadas en el servidor. */
export function axisTicks(
  max: number,
  format: (value: number) => string,
  count = 4,
): AxisTick[] {
  return niceTicks(max, count).map((value) => ({ value, label: format(value) }));
}

export function BarRows({
  data,
  axis,
}: {
  data: readonly BarDatum[];
  /** Marcas de eje ya formateadas. La última fija el tope de la escala. */
  axis: readonly AxisTick[];
}) {
  const tip = useTip();

  const top = axis[axis.length - 1]?.value ?? 0;
  const scale = linearScale(top);

  // La grilla como degradado: filetes de 1 px, sólidos, en las mismas
  // posiciones que las marcas del eje, así coinciden a cualquier ancho.
  const gridLines = axis
    .slice(1)
    .map(
      (tick) =>
        `linear-gradient(to right, ${CHROME.grid} 0 1px, transparent 1px 100%) ${scale(tick.value)}% 0 / 100% 100%`,
    )
    .join(", ");

  return (
    <>
      <div className={styles.bars} style={{ ["--grid-lines" as string]: gridLines }}>
        {data.map((datum) => {
          const color = datum.emphasis === false ? DEEMPHASIS : seriesColor(datum.seriesIndex ?? 0);
          const label = datum.meta === undefined ? datum.name : `${datum.name} · ${datum.meta}`;

          return (
            // **Una grilla por fila**, no una grilla plana con todas las celdas
            // de todas las filas. Con la plana, a 390 px la pista tomaba el
            // ancho completo y el orden del DOM dejaba el valor de una fila al
            // lado del nombre de la siguiente. Ver la nota de `.bars` en la
            // hoja: se encontró mirándolo en el navegador.
            <div className={styles.barRow} key={datum.id}>
              <span className={styles.barName} title={datum.name}>
                {datum.name}
              </span>

              <div className={styles.barTrack}>
                <div
                  className={styles.barFill}
                  style={{ width: `${scale(datum.value)}%`, ["--series" as string]: color }}
                />
                {/* Un botón solo para recibir foco: la misma información en
                    hover y en foco. Cubre la fila entera, así que el blanco es
                    de 24 px de alto aunque la barra sea más fina. */}
                <button
                  aria-label={`${datum.name}: ${datum.display}${datum.meta ? `, ${datum.meta}` : ""}`}
                  className={styles.barHit}
                  onBlur={tip.hide}
                  onFocus={(event) => tip.show(event, datum.display, label)}
                  onPointerEnter={(event) => tip.show(event, datum.display, label)}
                  onPointerLeave={tip.hide}
                  type="button"
                />
              </div>

              <span className={styles.barValue}>
                {datum.display}
                {datum.meta ? <span className={styles.barMeta}> · {datum.meta}</span> : null}
              </span>
            </div>
          );
        })}

        {axis.length > 1 ? (
          <div className={styles.axisRow}>
            {/* Celda vacía sobre la columna del nombre: las marcas del eje
                caen exactamente debajo de la pista a cualquier ancho. */}
            <span aria-hidden="true" />
            <div className={`${styles.axis} ${styles.axisTrack}`}>
              {axis.map((tick) => (
                <span key={tick.value}>{tick.label}</span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {tip.node}
    </>
  );
}

// ── Barra apilada (parte-de-un-todo) ────────────────────────────────────────

export type StackDatum = { id: string; label: string; value: number; display: string };

/**
 * Un riel apilado, con su leyenda de cifras debajo.
 *
 * Los tramos se reparten con `flex-grow` proporcional al valor y el hueco de
 * 2 px es `gap` — o sea superficie —, no un borde alrededor del tramo.
 *
 * Los tramos interiores **no llevan etiqueta adentro**: un tramo no tiene
 * extremo libre donde poner el número, y meterlo adentro lo recortaría en
 * cuanto el tramo sea chico. Las cifras van en las claves de abajo, que están
 * siempre visibles: la etiqueta directa no se cambió por un tooltip.
 */
export function StackBar({ data }: { data: readonly StackDatum[] }) {
  const tip = useTip();
  const positive = data.filter((datum) => datum.value > 0);

  if (positive.length === 0) {
    return (
      <p className={styles.decision}>
        Sin movimiento en el periodo.
      </p>
    );
  }

  return (
    <>
      <div className={styles.stack}>
        {positive.map((datum) => {
          // **El color sigue a la entidad, no a su posición tras el filtro.**
          // Se busca el índice en `data`, no en `positive`: si un método de
          // pago no se usó ese día, los que sí se usaron tienen que conservar
          // su tono. Repintar a los sobrevivientes engaña a quien ya aprendió
          // que efectivo es azul.
          const color = seriesColor(data.indexOf(datum));
          return (
            <button
              aria-label={`${datum.label}: ${datum.display}`}
              className={styles.stackSegment}
              key={datum.id}
              onBlur={tip.hide}
              onFocus={(event) => tip.show(event, datum.display, datum.label)}
              onPointerEnter={(event) => tip.show(event, datum.display, datum.label)}
              onPointerLeave={tip.hide}
              style={{
                flexGrow: datum.value,
                ["--series" as string]: color,
                border: 0,
                padding: 0,
              }}
              type="button"
            >
              <span className="ui-sr">{`${datum.label}: ${datum.display}`}</span>
            </button>
          );
        })}
      </div>

      <ul className={styles.stackKeys}>
        {data.map((datum, index) => (
          <li className={styles.stackKey} key={datum.id}>
            <span
              aria-hidden="true"
              className={styles.swatch}
              style={{ background: seriesColor(index) }}
            />
            <span className={styles.stackKeyLabel}>{datum.label}</span>
            <span className={styles.stackKeyValue}>{datum.display}</span>
          </li>
        ))}
      </ul>
      {tip.node}
    </>
  );
}

// ── Mapa de calor ───────────────────────────────────────────────────────────

export type HeatCell = {
  /** `null` = **sin dato**, que no es cero: la celda va punteada y vacía. */
  value: number | null;
  display: string;
};

/**
 * Grilla de magnitud con la rampa de un solo tono.
 *
 * Es la forma que resuelve el problema del tope de cuatro slots categóricos:
 * cinco motivos de variación o siete franjas horarias no caben en una paleta
 * categórica sin inventar tonos, y como mapa de calor no necesitan ninguno —
 * más oscuro es más, y la escala de abajo dice cuánto.
 *
 * Scrollea de lado **dentro de su propio contenedor**. La página no scrollea de
 * lado nunca: es el contrato responsive del panel.
 */
export function Heatmap({
  columns,
  rows,
  cells,
  scaleLabel,
  rowHeader = "",
}: {
  columns: readonly { id: string; label: string }[];
  rows: readonly { id: string; label: string }[];
  /** Matriz por filas: `cells[i][j]` es la fila `rows[i]`, columna `columns[j]`. */
  cells: readonly (readonly HeatCell[])[];
  /** Cómo se rotulan los dos extremos de la escala. */
  scaleLabel: { min: string; max: string };
  rowHeader?: string;
}) {
  const tip = useTip();

  // El máximo se toma sobre las celdas con dato: un `null` tratado como 0
  // aplanaría la escala si el periodo tuviera muchos huecos.
  const values = cells
    .flat()
    .map((cell) => cell.value)
    .filter((value): value is number => value !== null);
  const max = Math.max(0, ...values);

  return (
    <>
      <div className={styles.heatScroll} tabIndex={0}>
        <table className={styles.heat}>
          <thead>
            <tr>
              <th scope="col">{rowHeader}</th>
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.id}>
                <th className={styles.heatRowName} scope="row" title={row.label}>
                  {row.label}
                </th>
                {columns.map((column, columnIndex) => {
                  const cell = cells[rowIndex]?.[columnIndex] ?? { value: null, display: "—" };
                  const step =
                    max === 0
                      ? null
                      : sequentialStep(cell.value === null ? null : cell.value / max);

                  if (step === null) {
                    return (
                      <td
                        className={`${styles.heatCell} ${styles["heatCell--empty"]}`}
                        key={column.id}
                      >
                        {cell.display}
                      </td>
                    );
                  }

                  const label = `${row.label} · ${column.label}`;
                  return (
                    <td
                      className={styles.heatCell}
                      key={column.id}
                      onBlur={tip.hide}
                      onFocus={(event) => tip.show(event, cell.display, label)}
                      onPointerEnter={(event) => tip.show(event, cell.display, label)}
                      onPointerLeave={tip.hide}
                      style={{ background: step, color: inkOnSequential(step) }}
                      tabIndex={0}
                    >
                      {cell.display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.heatScale}>
        <span>{scaleLabel.min}</span>
        <span aria-hidden="true" className={styles.heatScaleSteps}>
          {SEQUENTIAL.map((step) => (
            <span className={styles.heatScaleStep} key={step} style={{ background: step }} />
          ))}
        </span>
        <span>{scaleLabel.max}</span>
      </p>
      {tip.node}
    </>
  );
}

// ── Tile de KPI ─────────────────────────────────────────────────────────────

/**
 * Cuando el dato es un número, la forma es un número.
 *
 * `deltaGoodWhen` es lo que evita el error de atar el color al signo: un alza
 * de inasistencia es mala y un alza de ingreso es buena. Sin este parámetro las
 * dos se verían verdes.
 */
export function StatTile({
  label,
  value,
  soft = false,
  delta,
  deltaGoodWhen = "up",
  deltaNote,
  spark,
}: {
  label: string;
  value: string;
  /** `true` para un valor que es texto y no cifra ("no se puede medir"). */
  soft?: boolean;
  delta?: Delta | null;
  deltaGoodWhen?: "up" | "down";
  /** Contra qué se compara: "vs. el mes anterior". */
  deltaNote?: string;
  spark?: readonly number[];
}) {
  const tone =
    delta === undefined || delta === null || delta.direction === "flat"
      ? ""
      : (delta.direction === deltaGoodWhen ? styles["tileDelta--good"] : styles["tileDelta--bad"]);

  const path = spark === undefined ? null : sparklinePath(spark, 72, 24);

  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={soft ? `${styles.tileValue} ${styles["tileValue--soft"]}` : styles.tileValue}>
        {value}
      </span>
      <div className={styles.tileFoot}>
        {delta ? (
          <span className={`${styles.tileDelta} ${tone}`}>
            {delta.label}
            {deltaNote ? <span className={styles.tileLabel}>{deltaNote}</span> : null}
          </span>
        ) : (
          <span className={styles.tileDelta}>{deltaNote ?? ""}</span>
        )}

        {path === null ? null : (
          <svg
            aria-hidden="true"
            className={styles.spark}
            viewBox="0 0 72 24"
            preserveAspectRatio="none"
          >
            <path
              d={path}
              fill="none"
              stroke={seriesColor(0)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={MARK.line}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div className={styles.tiles}>{children}</div>;
}
