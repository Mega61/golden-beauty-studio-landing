/**
 * Los identificadores con los que la plata cruza hacia afuera.
 *
 * Actual Budget deduplica las transacciones importadas por `imported_id` y
 * **no actualiza** una que ya importó. Eso convierte a este archivo, que no
 * hace más que pegar cadenas, en uno de los dos o tres del panel donde un error
 * cuesta plata de verdad:
 *
 * > **Dos cosas distintas con el mismo `imported_id`** ⇒ Actual se come la
 * > segunda en silencio y el ingreso del mes queda corto.
 * > **La misma cosa con dos `imported_id` distintos** ⇒ Actual importa las dos
 * > y el ingreso queda inflado.
 *
 * Ninguno de los dos da error visible. Por eso los namespaces son constantes de
 * este módulo, el test es exhaustivo sobre miles de combinaciones en vez de
 * ilustrativo sobre tres, y nadie construye uno de estos ids concatenando a
 * mano en otro archivo.
 *
 * Tres namespaces, y **la separación entre ellos es estructural, no una
 * convención**:
 *
 * | Namespace | Qué llavea | Quién lo escribe |
 * | --- | --- | --- |
 * | `agendapro-tx:` | las transacciones históricas scrapeadas de Agenda Pro | ya está en Actual, **congelado para siempre** |
 * | `ea-tx:` | una cita cerrada en el panel, empujada en el cierre diario | el push de C3 |
 * | `ea-tx:<id>:adj<n>` | una corrección posterior al cierre de esa misma cita | el push de C3 |
 *
 * El histórico no se re-llavea nunca: cambiarle el prefijo a filas que Actual ya
 * importó las volvería a importar como duplicados. `ACTUAL_SYNC_SINCE` marca la
 * frontera entre los dos mundos, y ese corte vive en `actual-sync`, no acá.
 *
 * Por qué las correcciones son ids nuevos y no una reescritura: Actual no
 * actualiza montos. Corregir un ticket después del cierre y reusar el
 * `ea-tx:<id>` original dejaría a Actual con la cifra vieja para siempre, sin
 * error. Un ajuste con id propio sí entra, como el movimiento que realmente es.
 */

/** Prefijo de las transacciones históricas de Agenda Pro. Congelado. */
export const AGENDAPRO_TX_PREFIX = "agendapro-tx:";

/** Prefijo de las transacciones nuevas, las que produce el panel. */
export const EA_TX_PREFIX = "ea-tx:";

/**
 * Prefijo con el que se llavean las filas `Payment` **en Strapi** — que no es
 * lo mismo que el `imported_id` de Actual.
 *
 * Son dos sistemas con dos llaves y por eso son dos prefijos distintos: una
 * fila `Payment` es "la cuenta de esta cita" y una transacción de Actual es "el
 * movimiento de plata", y una cita corregida tiene una fila `Payment` y dos
 * movimientos.
 */
export const EA_PAYMENT_PREFIX = "ea-appt:";

/** El separador de los segmentos de ajuste. */
const ADJUSTMENT_SEPARATOR = ":adj";

export class IngestIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestIdError";
  }
}

/**
 * Un id de EA válido: entero positivo y seguro.
 *
 * La validación no es paranoia de tipos. Un `id` con ceros a la izquierda
 * (`"007"`) produciría `ea-tx:007`, que es un identificador **distinto** de
 * `ea-tx:7` para la misma cita: la corrección de mañana no encontraría la
 * transacción de hoy y Actual importaría las dos. Un `id` no entero produciría
 * `ea-tx:7.5`, que ni siquiera existe. Y un `id` que traiga `:` rompería la
 * separación entre el id y el sufijo de ajuste, que es la única cosa que
 * mantiene los dos formatos disjuntos.
 */
function assertEaId(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IngestIdError(`${what} tiene que ser un entero positivo, y llegó ${value}`);
  }
}

/**
 * `imported_id` de Actual para una cita cerrada.
 *
 * Es el que se usa en el push del cierre diario. Una cita, un id, para siempre.
 */
export function buildEaImportedId(eaAppointmentId: number): string {
  assertEaId(eaAppointmentId, "El id de la cita");
  return `${EA_TX_PREFIX}${eaAppointmentId}`;
}

/**
 * `imported_id` de Actual para el ajuste número `sequence` de una cita.
 *
 * `sequence` arranca en 1 y es **el número de ajustes que ya existen más uno**,
 * no un contador global: dos ajustes sobre citas distintas pueden ser los dos
 * el `adj1`. Quien lo llama tiene que leer cuántos ajustes lleva esa cita —
 * inventarlo es cómo se pisan dos correcciones.
 */
export function buildEaAdjustmentImportedId(eaAppointmentId: number, sequence: number): string {
  assertEaId(eaAppointmentId, "El id de la cita");
  assertEaId(sequence, "El número de ajuste");
  return `${EA_TX_PREFIX}${eaAppointmentId}${ADJUSTMENT_SEPARATOR}${sequence}`;
}

/**
 * `imported_id` histórico de Agenda Pro.
 *
 * Existe **solo para poder afirmar que no colisiona** con los otros dos, y para
 * que el reproceso del histórico (si alguna vez hace falta) reconstruya
 * exactamente el mismo id que Actual ya tiene. Nada del panel escribe filas de
 * Agenda Pro nuevas.
 *
 * El `txId` es una cadena opaca del scraper, así que no se normaliza ni se
 * recorta: cualquier transformación produciría un id distinto del que ya está
 * en Actual, y ése es precisamente el error que duplica ingresos. Lo único que
 * se rechaza es lo que no puede haber sido un id: vacío o solo espacios.
 */
export function buildAgendaproImportedId(txId: string): string {
  if (txId.trim() === "") {
    throw new IngestIdError(`El tx_id de Agenda Pro no puede estar vacío: ${JSON.stringify(txId)}`);
  }

  return `${AGENDAPRO_TX_PREFIX}${txId}`;
}

/** La llave de la fila `Payment` en Strapi para una cita. */
export function buildPaymentSourceTxId(eaAppointmentId: number): string {
  assertEaId(eaAppointmentId, "El id de la cita");
  return `${EA_PAYMENT_PREFIX}${eaAppointmentId}`;
}

/** Lo que un `imported_id` significa, una vez leído de vuelta. */
export type ParsedImportedId =
  | { source: "agendapro"; txId: string }
  /** `sequence: null` = la transacción de la cita; un número = su ajuste n. */
  | { source: "ea"; eaAppointmentId: number; sequence: number | null };

/**
 * Lee un `imported_id` de vuelta a lo que significa, o `null` si no es uno de
 * los nuestros.
 *
 * Se usa en el dry-run de `actual-sync` y en Diagnóstico. Es estricto a
 * propósito: reconstruye el id a partir de lo que leyó y lo compara con la
 * entrada, así que cualquier forma que este módulo no habría producido —
 * `ea-tx:007`, `ea-tx:1:adj0`, `ea-tx:1:adj1:adj2` — devuelve `null` en vez de
 * un parseo optimista. Un id que no se puede reconstruir no es un id nuestro,
 * venga de donde venga.
 */
export function parseImportedId(value: unknown): ParsedImportedId | null {
  if (typeof value !== "string") return null;

  if (value.startsWith(AGENDAPRO_TX_PREFIX)) {
    const txId = value.slice(AGENDAPRO_TX_PREFIX.length);
    return txId.trim() === "" ? null : { source: "agendapro", txId };
  }

  if (!value.startsWith(EA_TX_PREFIX)) return null;

  const rest = value.slice(EA_TX_PREFIX.length);
  const separator = rest.indexOf(ADJUSTMENT_SEPARATOR);

  if (separator === -1) {
    const id = Number(rest);
    if (!isCanonicalId(rest, id)) return null;
    return { source: "ea", eaAppointmentId: id, sequence: null };
  }

  const idPart = rest.slice(0, separator);
  const seqPart = rest.slice(separator + ADJUSTMENT_SEPARATOR.length);
  const id = Number(idPart);
  const sequence = Number(seqPart);

  if (!isCanonicalId(idPart, id) || !isCanonicalId(seqPart, sequence)) return null;

  return { source: "ea", eaAppointmentId: id, sequence };
}

/** ¿La cadena es exactamente cómo este módulo escribiría ese entero? */
function isCanonicalId(text: string, parsed: number): boolean {
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === text;
}
