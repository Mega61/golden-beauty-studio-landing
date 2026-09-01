import type { ReactNode } from "react";
import {
  listShape,
  secondaryLine,
  visibleColumns,
  type Column,
} from "./table-model";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";

/**
 * Tabla de datos que colapsa a lista de dos líneas.
 *
 * **Las dos formas se renderizan las dos, y CSS decide cuál se ve.** No hay
 * `matchMedia` ni estado de ancho: eso obligaría a que el componente fuera
 * cliente, produciría un parpadeo en la primera pintura y rompería la
 * impresión, donde no hay viewport que consultar. El costo es un poco de DOM
 * duplicado; a cambio la tabla funciona dentro de un Server Component y la
 * hoja de ruta del día sale bien de la impresora. La mitad oculta lleva
 * `aria-hidden`, así el lector de pantalla recorre las filas una sola vez.
 *
 * **Una fila accionable trae un `<button>` de verdad**, dentro de la primera
 * celda. El `onClick` de la fila entera es comodidad para el puntero; el botón
 * es lo que hace que la fila exista para el teclado y para el lector de
 * pantalla. Una fila que solo responde al clic es una acción disponible solo
 * por gesto, y eso el plan lo prohíbe.
 *
 * Qué NO hace: scroll horizontal. Si a 768 px no caben las columnas, la
 * respuesta es marcar más columnas como `from: "lg"`, no dejar que la página se
 * arrastre de lado.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  rowAction = "Abrir",
  selectedKey,
  loading = false,
  loadingRows = 5,
  empty,
}: {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  /** Qué es esta tabla. Se anuncia con lector de pantalla. */
  caption: string;
  onRowClick?: (row: Row) => void;
  /** Verbo del botón de la fila, para el lector de pantalla: "Abrir la cita de…". */
  rowAction?: string;
  selectedKey?: string | null;
  loading?: boolean;
  loadingRows?: number;
  /** El vacío enseña la interfaz. Sin esto se cae al genérico. */
  empty?: ReactNode;
}) {
  const md = visibleColumns(columns, "md");
  const lg = visibleColumns(columns, "lg");
  const shape = listShape(columns);
  const interactive = Boolean(onRowClick);

  if (loading) return <TableSkeleton columns={lg.length} rows={loadingRows} />;

  if (rows.length === 0) {
    return (
      <>
        {empty ?? (
          <EmptyState
            icon="buscar"
            title="No hay nada acá todavía"
            body="Cuando haya datos van a aparecer en esta lista."
          />
        )}
      </>
    );
  }

  return (
    <>
      {/* --- Lista de dos líneas: hasta 767 px ------------------------------ */}
      <ul className="ui-list ui-only-sm" aria-label={caption}>
        {rows.map((row) => {
          const key = rowKey(row);
          const second = secondaryLine(shape, row);
          const primaryText = shape.primary?.text?.(row) ?? "";
          return (
            <li key={key}>
              <RowShell
                interactive={interactive}
                selected={selectedKey === key}
                label={primaryText ? `${rowAction}: ${primaryText}` : rowAction}
                onClick={() => onRowClick?.(row)}
              >
                <span className="ui-list__body">
                  <span className="ui-list__primary">
                    {shape.primary ? shape.primary.render(row) : key}
                  </span>
                  {second ? (
                    <span className="ui-list__secondary">{second}</span>
                  ) : null}
                </span>
                {shape.trailing.length > 0 ? (
                  <span className="ui-list__trail">
                    {shape.trailing.map((c) => (
                      <span
                        key={c.key}
                        className={c.numeric ? "ui-num" : undefined}
                      >
                        {c.render(row)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </RowShell>
            </li>
          );
        })}
      </ul>

      {/* --- Tabla: desde 768 px ------------------------------------------- */}
      <div className="ui-only-md">
        <table className="ui-table">
          <caption className="ui-sr">{caption}</caption>
          <thead>
            <tr>
              {lg.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  data-align={c.align === "end" || c.numeric ? "end" : undefined}
                  className={md.includes(c) ? undefined : "ui-only-lg-cell"}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const primaryText = shape.primary?.text?.(row) ?? "";
              return (
                <tr
                  key={key}
                  data-interactive={interactive ? "true" : undefined}
                  aria-selected={selectedKey === key || undefined}
                  onClick={interactive ? () => onRowClick?.(row) : undefined}
                >
                  {lg.map((c, i) => (
                    <td
                      key={c.key}
                      data-align={
                        c.align === "end" || c.numeric ? "end" : undefined
                      }
                      data-numeric={c.numeric ? "true" : undefined}
                      className={md.includes(c) ? undefined : "ui-only-lg-cell"}
                    >
                      {interactive && i === 0 ? (
                        <button
                          type="button"
                          className="ui-cellbtn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowClick?.(row);
                          }}
                        >
                          {c.render(row)}
                          <span className="ui-sr">
                            {" — "}
                            {rowAction}
                            {primaryText ? `: ${primaryText}` : ""}
                          </span>
                        </button>
                      ) : (
                        c.render(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RowShell({
  interactive,
  selected,
  label,
  onClick,
  children,
}: {
  interactive: boolean;
  selected: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  if (!interactive) {
    return (
      <div className="ui-list__row" data-interactive="false">
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ui-list__row"
      data-interactive="true"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Esqueleto con la forma de la tabla, no un spinner en el medio. */
function TableSkeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="ui-sr">Cargando…</span>
      <div className="ui-skeltable">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="ui-skeltable__row"
            style={{
              gridTemplateColumns: `2fr repeat(${Math.max(columns - 1, 1)}, 1fr)`,
            }}
          >
            {Array.from({ length: Math.max(columns, 2) }).map((__, c) => (
              <Skeleton key={c} height={12} width={c === 0 ? "70%" : "45%"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
