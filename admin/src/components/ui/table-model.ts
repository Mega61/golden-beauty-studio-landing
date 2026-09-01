/**
 * El modelo de la tabla, aparte del componente.
 *
 * La regla del plan es "tablas que colapsan a lista de dos líneas en móvil,
 * nunca scroll lateral". Decidir *qué* columnas sobreviven en cada ancho, y
 * qué va en cada una de esas dos líneas, es lógica: se puede equivocar en
 * silencio y solo se nota mirando un celular. Por eso vive acá, en funciones
 * puras, y tiene tests.
 *
 * El componente `DataTable` solo pinta lo que estas funciones deciden.
 */

/**
 * Cuándo aparece una columna.
 *
 * - `siempre` — sobrevive incluso en la lista de dos líneas. Es la que la
 *   usuaria buscaría para identificar la fila.
 * - `md` — desde 768 px (tabla con columnas prioritarias).
 * - `lg` — desde 1024 px (la tabla completa).
 */
export type ColumnFrom = "siempre" | "md" | "lg";

/** Qué papel juega la columna cuando la tabla se vuelve lista. */
export type ListSlot = "primary" | "secondary" | "trailing" | "oculto";

export type Column<Row> = {
  key: string;
  /** Encabezado. Va en versalitas de 12 px; nunca en Cormorant. */
  header: string;
  from?: ColumnFrom;
  /** Alineación de la celda. Los montos van a la derecha. */
  align?: "start" | "end";
  /** Marca la celda como cifra: `tabular-nums` y alineada a la derecha. */
  numeric?: boolean;
  /**
   * Dónde cae esta columna en la lista de dos líneas. Si no se declara, la
   * columna simplemente no aparece en móvil — que a veces es lo correcto, pero
   * conviene decirlo a propósito.
   */
  listSlot?: ListSlot;
  /** Ancho sugerido en la tabla. Nada de anchos fijos en móvil. */
  width?: string;
  render: (row: Row) => React.ReactNode;
  /** Texto plano de la celda, para la lista de dos líneas y para la impresión. */
  text?: (row: Row) => string;
};

export type Breakpoint = "sm" | "md" | "lg";

const RANK: Record<ColumnFrom, number> = { siempre: 0, md: 1, lg: 2 };
const AT: Record<Breakpoint, number> = { sm: 0, md: 1, lg: 2 };

/**
 * Las columnas que se dibujan a un ancho dado.
 *
 * En `sm` la respuesta correcta es "ninguna": a ese ancho no hay tabla, hay
 * lista. Devolver las columnas `siempre` invitaría a renderizar una tabla de
 * dos columnas y llamarla responsive, que es justo lo que el plan prohíbe.
 */
export function visibleColumns<Row>(
  columns: ReadonlyArray<Column<Row>>,
  at: Breakpoint,
): Array<Column<Row>> {
  if (at === "sm") return [];
  return columns.filter((c) => RANK[c.from ?? "lg"] <= AT[at]);
}

export type ListShape<Row> = {
  primary: Column<Row> | null;
  secondary: Array<Column<Row>>;
  trailing: Array<Column<Row>>;
};

/**
 * Cómo se reparte una fila entre las dos líneas de la lista móvil.
 *
 * Contrato:
 * - Hay **una** columna `primary` — la que identifica la fila. Si nadie la
 *   declara se toma la primera columna, que es la convención de toda tabla:
 *   la primera columna es el nombre de la cosa.
 * - La segunda línea concatena las `secondary` con `·`.
 * - Las `trailing` van a la derecha, apiladas: el monto arriba, la pastilla de
 *   estado abajo. Es donde el ojo busca la plata y el estado.
 *
 * Se limita a dos `trailing` a propósito. Con tres, en 390 px el nombre de la
 * clienta se recorta a la mitad y la fila deja de servir para identificarla.
 */
export function listShape<Row>(
  columns: ReadonlyArray<Column<Row>>,
): ListShape<Row> {
  const declared = columns.filter((c) => c.listSlot === "primary");
  const primary = declared[0] ?? columns[0] ?? null;

  const secondary = columns.filter(
    (c) => c !== primary && c.listSlot === "secondary",
  );
  const trailing = columns
    .filter((c) => c !== primary && c.listSlot === "trailing")
    .slice(0, 2);

  return { primary, secondary, trailing };
}

/** La segunda línea, ya armada: `"2:30 p. m. · Lina · Acrílicas"`. */
export function secondaryLine<Row>(
  shape: ListShape<Row>,
  row: Row,
  separator = " · ",
): string {
  return shape.secondary
    .map((c) => (c.text ? c.text(row) : ""))
    .filter((s) => s.trim() !== "")
    .join(separator);
}
