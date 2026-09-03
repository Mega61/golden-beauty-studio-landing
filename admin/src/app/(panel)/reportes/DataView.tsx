import type { ReactNode } from "react";

import styles from "./charts.module.css";

/**
 * La tabla gemela de un gráfico.
 *
 * **No es un extra de accesibilidad, es la condición para que el gráfico sea
 * legal.** La regla de `dataviz` es que un tooltip realza y nunca es la única
 * forma de leer un valor, y que toda escala continua tiene su equivalente
 * limpio en tabla. Sin esto, la ocupación de una franja solo existiría como un
 * tono de azul.
 *
 * ## Por qué vive fuera de `Charts.tsx`
 *
 * `Charts.tsx` es `"use client"` —lo necesita para el tooltip— y las columnas
 * de esta tabla se declaran con una función por celda (`cell: (row) => …`).
 * **Una función no cruza la frontera Server → Client:** React no la puede
 * serializar y el render falla. Este archivo no lleva la directiva, así que la
 * tabla se arma y se renderiza entera en el servidor, con sus funciones
 * corriendo ahí, y llega al marco del gráfico ya convertida en elementos.
 *
 * Es también la razón de que se pueda leer sin JavaScript: la tabla está en el
 * HTML de la primera respuesta.
 */

export type TableColumn<T> = {
  header: string;
  /** Alinea a la derecha y aplica `tabular-nums`: columnas que se comparan. */
  numeric?: boolean;
  cell: (row: T) => ReactNode;
};

export function DataView<T>({
  rows,
  columns,
  caption,
  rowKey,
}: {
  rows: readonly T[];
  columns: readonly TableColumn<T>[];
  /** Para lectores de pantalla: qué contiene la tabla. */
  caption: string;
  rowKey: (row: T, index: number) => string;
}) {
  return (
    <table className={styles.dataTable}>
      <caption className="ui-sr">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              data-numeric={column.numeric ? "true" : undefined}
              key={column.header}
              scope="col"
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey(row, index)}>
            {columns.map((column) => (
              <td data-numeric={column.numeric ? "true" : undefined} key={column.header}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
