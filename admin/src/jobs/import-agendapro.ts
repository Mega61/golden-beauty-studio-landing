/**
 * Importar el export de Agenda Pro: clientas y su historia.
 *
 * Es el paquete que hace posible el corte. Sin él, los teléfonos que importan
 * siguen del otro lado y cualquier reporte de "clienta nueva" contaría la base
 * entera como nueva el primer mes.
 *
 * ## Dos destinos que no son el mismo
 *
 * - **Las clientas van a EA**, por su API, porque son el presente: hay que
 *   poder agendarles una cita mañana.
 * - **La historia va a `gbs_admin.legacy_appointment`**, no al calendario de
 *   EA. Rellenar el calendario con dos años de citas pasadas ensuciaría la
 *   agenda con la que se trabaja todos los días para ganar un dato que la ficha
 *   de la clienta ya lee de las dos fuentes unidas.
 *
 * ⚠ **Y la plata del histórico NO se empuja a ingest, nunca.** Ya está en Actual
 * Budget, metida por el scraper nocturno con `imported_id = agendapro-tx:<id>`.
 * `legacy_appointment.amount_charged` existe solo para que los reportes del
 * panel tengan pasado. Empujarla otra vez duplicaría el ingreso histórico
 * completo, en silencio y sin error visible. Ver `lib/ingest-id.ts`.
 *
 * ## Por qué el mapeo de columnas es un parámetro
 *
 * Nadie en este repo ha visto el archivo que Agenda Pro produce. Escribir el
 * parser contra una forma inventada sería escribir un parser que hay que tirar.
 * Así que el módulo trabaja contra **filas ya mapeadas** y el mapeo se resuelve
 * afuera, con detección por nombre de encabezado y anulación manual: lo que
 * cambie el día que se vea el archivo de verdad es una tabla de sinónimos, no
 * la lógica.
 *
 * ## Qué es puro acá y qué no
 *
 * Todo lo de este archivo es puro: parsear el texto, decidir qué crear y qué
 * fusionar, y armar las filas. El CLI hace las dos cosas que no se pueden
 * testear sin red — leer el archivo y escribirle a EA y a MySQL — y nada más.
 */

import { normalizePhoneE164, type E164 } from "@/app/(panel)/clientes/identity";
import { EA_TIME_ZONE, eaLocalToInstant, parseEaLocalDateTime } from "@/lib/ea";

// ---------------------------------------------------------------------------
// Leer el archivo
// ---------------------------------------------------------------------------

/**
 * Parser de CSV, con comillas.
 *
 * Sí, escrito a mano, y sí, "usa una librería" es normalmente el consejo
 * correcto. Acá no: el panel no tiene ninguna dependencia de parseo y meter una
 * para un script que corre tres veces en la vida del estudio es cargar una
 * dependencia para siempre por un uso. Lo que un CSV real trae y esto atiende:
 * comillas dobles, comas dentro de comillas, comillas escapadas duplicándolas,
 * saltos de línea dentro de un campo entrecomillado, y `\\r\\n`.
 *
 * Lo que **no** atiende, a propósito: Excel binario (`.xlsx`). Si el export sale
 * en ese formato se abre y se guarda como CSV, que es un paso manual de diez
 * segundos y no una librería nueva.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // El BOM de un archivo exportado desde Excel viaja pegado al primer
  // encabezado y lo vuelve irreconocible: `"﻿Teléfono"` no es `"Teléfono"`.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // Dos comillas seguidas dentro de un campo entrecomillado son una comilla
      // literal, no el cierre.
      if (source[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      continue;
    }

    if (char === sep) {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field);
      // Una línea en blanco no es una fila vacía: es una línea en blanco. Sin
      // esto, un archivo que termina con salto de línea produce una fila
      // fantasma que después aparece como "una clienta sin teléfono".
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);

  return rows;
}

/**
 * Coma o punto y coma.
 *
 * Un Excel en español exporta con `;`, uno en inglés con `,`, y el mismo
 * estudio puede producir los dos según quién bajó el archivo. Se cuenta cuál
 * aparece más en la primera línea, que es el encabezado y el lugar donde no hay
 * texto libre que confunda la cuenta.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const commas = firstLine.split(",").length;
  const semicolons = firstLine.split(";").length;
  return semicolons > commas ? ";" : ",";
}

// ---------------------------------------------------------------------------
// Mapear columnas
// ---------------------------------------------------------------------------

/** Los campos que el importador sabe usar. Todos opcionales salvo los dichos. */
export type ImportField =
  | "phone"
  | "name"
  | "lastName"
  | "email"
  | "startedAt"
  | "endedAt"
  | "serviceName"
  | "providerName"
  | "amount"
  | "status"
  | "paidStatus"
  | "sourceId";

/**
 * Nombres de encabezado que se reconocen para cada campo, ya normalizados.
 *
 * Es una lista de sinónimos y va a estar incompleta hasta que alguien vea el
 * archivo real. Por eso el CLI **imprime qué columna eligió para cada campo** y
 * deja anular cualquiera a mano: una detección equivocada que se ve es un
 * ajuste; una que no se ve es una base de clientas importada al revés.
 */
const HEADER_SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  phone: ["telefono", "celular", "movil", "telefonomovil", "phone", "mobile", "contacto"],
  name: ["nombre", "nombres", "firstname", "cliente", "nombrecliente", "name"],
  lastName: ["apellido", "apellidos", "lastname", "surname"],
  email: ["email", "correo", "correoelectronico", "mail"],
  // `fechaderealizacion` primero: el export trae cuatro columnas de fecha
  // —realización, creación, última modificación y pago— y la que importa es
  // cuándo fue la cita. Las otras describen el registro, no el servicio.
  startedAt: [
    "fechaderealizacion",
    "fechadeatencion",
    "fechahora",
    "fechainicio",
    "fecha",
    "inicio",
    "starttime",
    "start",
    "date",
  ],
  endedAt: ["fechafin", "horafin", "fin", "endtime", "end"],
  serviceName: ["servicio", "servicios", "tratamiento", "service"],
  providerName: [
    "prestador",
    "profesional",
    "especialista",
    "tecnica",
    "staff",
    "provider",
    "empleado",
  ],
  // ⚠ `precioreal` **antes** que cualquier otra cosa, y `preciolista` no está
  // en la lista ni puede estar. En el export real de 173 citas, las dos
  // columnas difieren en 96 — más de la mitad. Importar la de lista en vez de
  // la real no falla: infla el histórico de ingresos y nadie lo nota.
  amount: [
    "precioreal",
    "montoreal",
    "totalpagado",
    "monto",
    "total",
    "valor",
    "pagado",
    "importe",
    "amount",
    "precio",
  ],
  status: ["estado", "estadocita", "estadodelacita", "status"],
  // Si el cobro se concretó. No es lo mismo que el estado de la cita: una cita
  // `Asiste` puede estar sin pagar.
  paidStatus: ["estadodepago", "estadopago", "pagada", "paymentstatus"],
  sourceId: ["idcita", "idreserva", "codigo", "folio", "numero", "id"],
};

/** Encabezado → llave comparable. Sin tildes, sin espacios, sin mayúsculas. */
export function headerKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export type ColumnMap = Partial<Record<ImportField, number>>;

/**
 * Qué columna es cada cosa, mirando el encabezado.
 *
 * Gana la **primera** coincidencia de izquierda a derecha, y un sinónimo más
 * específico no le gana a uno que apareció antes: si el archivo trae `Teléfono`
 * y `Teléfono fijo`, se queda con el primero. Es arbitrario y está bien, porque
 * el CLI lo imprime y se puede anular; adivinar cuál es "el bueno" con reglas
 * más finas sería adivinar mejor y seguir adivinando.
 */
export function detectColumns(header: readonly string[]): ColumnMap {
  const keys = header.map(headerKey);
  const map: ColumnMap = {};

  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS) as [
    ImportField,
    readonly string[],
  ][]) {
    // **Se recorren los sinónimos, no las columnas.** Es al revés de lo obvio y
    // es la diferencia entre acertar y no: con "Precio lista" en la columna N y
    // "Precio real" en la O, recorrer columnas se queda con la primera que
    // coincida —la de lista— y recorrer sinónimos deja ganar al más específico,
    // que es el que declara la lista de arriba.
    for (const synonym of synonyms) {
      const index = keys.indexOf(synonym);
      if (index !== -1) {
        map[field] = index;
        break;
      }
    }
  }

  return map;
}

/** Una fila del export, ya mapeada. Todo es texto crudo todavía. */
export type RawRow = Partial<Record<ImportField, string>>;

export function applyColumns(row: readonly string[], map: ColumnMap): RawRow {
  const out: RawRow = {};
  for (const [field, index] of Object.entries(map) as [ImportField, number][]) {
    const value = row[index];
    if (value !== undefined && value.trim() !== "") out[field] = value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Las clientas
// ---------------------------------------------------------------------------

export type CustomerPlanEntry = {
  phone: E164;
  firstName: string;
  lastName: string;
  /** `null` cuando el export no traía correo, o traía uno que huele a relleno. */
  email: string | null;
  /** Cuántas filas del export corresponden a esta clienta. */
  rows: number;
};

export type CustomerPlan = {
  /** Se crean en EA: teléfono normalizado y sin clienta con ese teléfono allá. */
  create: CustomerPlanEntry[];
  /** Ya existen en EA con ese teléfono. No se tocan. */
  existing: { phone: E164; eaCustomerId: number; name: string }[];
  /**
   * Filas que no se pueden usar como clienta: sin teléfono, o con algo que no
   * es un teléfono. **No se descartan en silencio** — el CLI las imprime, y una
   * persona decide. Son las que hay que llamar para pedirle el número.
   */
  unusable: { raw: string | null; name: string; rows: number }[];
};

/**
 * Qué clientas crear en EA.
 *
 * ## La llave es el teléfono, y solo el teléfono
 *
 * Dos filas del export con el mismo número son la misma clienta aunque el
 * nombre esté escrito distinto ("Ana M." y "Ana María"), porque el número es lo
 * que la identifica cuando llama. Se conserva **el nombre más largo** de las
 * variantes: es el que más información trae, y elegir el primero dejaría "Ana
 * M." de por vida solo porque esa cita fue antes.
 *
 * ## El correo se copia, no se inventa
 *
 * EA deduplica por correo y el flujo viejo resolvía la falta inventando
 * direcciones. Un correo falso viaja como *attendee* del evento de Google,
 * rebota, y ensucia la ficha para siempre. Sin correo en el export, sin correo
 * en EA — que es lo que `identity.ts` ya decidió para el panel entero.
 */
export function planCustomers(input: {
  rows: readonly RawRow[];
  /** Las clientas que EA ya tiene. Su teléfono se normaliza acá. */
  existing: readonly { id: number; phone: string | null; name: string }[];
}): CustomerPlan {
  const existingByPhone = new Map<string, { id: number; name: string }>();
  for (const customer of input.existing) {
    const phone = normalizePhoneE164(customer.phone);
    if (phone !== null && !existingByPhone.has(phone)) {
      existingByPhone.set(phone, { id: customer.id, name: customer.name });
    }
  }

  const byPhone = new Map<string, CustomerPlanEntry>();
  const unusableByKey = new Map<string, { raw: string | null; name: string; rows: number }>();

  for (const row of input.rows) {
    const phone = normalizePhoneE164(row.phone ?? null);
    const { firstName, lastName } = splitName(row.name, row.lastName);

    if (phone === null) {
      // La llave del agrupado es lo que se escribió, no el nombre: dos clientas
      // distintas sin teléfono son dos problemas distintos, y dos filas con el
      // mismo "N/A" son la misma fila repetida.
      const key = `${row.phone ?? ""}|${firstName} ${lastName}`.trim();
      const found = unusableByKey.get(key);
      if (found) found.rows += 1;
      else
        unusableByKey.set(key, {
          raw: row.phone ?? null,
          name: `${firstName} ${lastName}`.trim(),
          rows: 1,
        });
      continue;
    }

    const found = byPhone.get(phone);
    if (found) {
      found.rows += 1;
      // El nombre más largo gana: trae más información que el más corto.
      const candidate = `${firstName} ${lastName}`.trim();
      if (candidate.length > `${found.firstName} ${found.lastName}`.trim().length) {
        found.firstName = firstName;
        found.lastName = lastName;
      }
      found.email = found.email ?? cleanEmail(row.email);
      continue;
    }

    byPhone.set(phone, {
      phone,
      firstName,
      lastName,
      email: cleanEmail(row.email),
      rows: 1,
    });
  }

  const create: CustomerPlanEntry[] = [];
  const existing: CustomerPlan["existing"] = [];

  for (const [phone, entry] of byPhone) {
    const already = existingByPhone.get(phone);
    if (already) {
      existing.push({ phone: phone as E164, eaCustomerId: already.id, name: already.name });
    } else {
      create.push(entry);
    }
  }

  // Orden estable: dos corridas sobre el mismo archivo producen el mismo plan,
  // y eso es lo que deja compararlas antes de aplicar.
  create.sort((a, b) => a.phone.localeCompare(b.phone));
  existing.sort((a, b) => a.phone.localeCompare(b.phone));

  return {
    create,
    existing,
    unusable: [...unusableByKey.values()].sort((a, b) => b.rows - a.rows),
  };
}

/**
 * Nombre y apellido a partir de lo que trajo el export.
 *
 * Con dos columnas es directo. Con una sola —lo habitual— se parte en el primer
 * espacio y **todo lo demás es apellido**: "Ana María Ríos Pérez" es "Ana" +
 * "María Ríos Pérez", que está mal, y la alternativa (partir por la mitad,
 * adivinar apellidos compuestos) está mal más seguido. Lo que importa es que el
 * nombre completo se conserve entero para que la clienta se reconozca en su
 * confirmación; cuál mitad va en cada casilla es cosmético.
 */
export function splitName(
  name: string | undefined,
  lastName: string | undefined,
): { firstName: string; lastName: string } {
  const first = clearPlaceholder(name);
  const last = clearPlaceholder(lastName);

  if (last !== "") return { firstName: first, lastName: last };
  if (first === "") return { firstName: "", lastName: "" };

  const space = first.indexOf(" ");
  if (space === -1) return { firstName: first, lastName: "" };

  return { firstName: first.slice(0, space), lastName: first.slice(space + 1).trim() };
}

/**
 * Un relleno que alguien escribió para poder guardar el formulario.
 *
 * En el export real, **20 de 173 apellidos son un guion bajo**. Importarlo tal
 * cual deja clientas llamadas "Julian _", y ese nombre viaja a la confirmación
 * de la cita. Campo vacío es más honesto que campo inventado — la misma regla
 * que rige los correos.
 */
function clearPlaceholder(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return /^[_\-.\s]*$/.test(trimmed) || /^(na|n\/a|nn|sin|ninguno)$/i.test(trimmed)
    ? ""
    : trimmed;
}

/**
 * El correo, o `null` si huele a relleno.
 *
 * Los `sin@correo.com` y `noemail@agendapro.com` de un export viejo son
 * exactamente los correos inventados que `identity.ts` marca en la ficha.
 * Importarlos sería volver a sembrar el problema que el panel ya detecta.
 */
export function cleanEmail(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  const local = value.slice(0, value.indexOf("@"));
  const FILLER = ["sin", "sincorreo", "noemail", "notiene", "na", "nn", "test", "correo"];
  if (FILLER.includes(local)) return null;

  return value;
}

// ---------------------------------------------------------------------------
// La historia
// ---------------------------------------------------------------------------

/**
 * ¿Ese cobro se concretó?
 *
 * En el export real hay 37 citas sin pagar de 173: 27 son canceladas o
 * inasistencias —donde nunca hubo plata— y el resto son citas atendidas que
 * quedaron sin registrar el pago. Importar el precio de las 37 como ingreso
 * inflaría el histórico con plata que no entró.
 *
 * La prueba es por la negativa (`no pagada`, `sin pago`, `pendiente`) y no por
 * la positiva: los valores afirmativos varían —"Pago asociado", "Pagada",
 * "Pagado"— y una lista blanca incompleta convertiría un cobro real en un
 * `null`, que es perder plata del reporte. **Ante la duda, se cuenta como
 * pagada**, y el cierre de caja del mes ya no es responsabilidad del histórico.
 */
export function isPaid(raw: string | undefined): boolean {
  const value = (raw ?? "").trim();
  if (value === "") return true;
  return !/(^|\s)(no|sin)\s|pendiente|impag|adeud/i.test(value);
}

export type LegacyRow = {
  source_id: string;
  started_at: Date;
  ended_at: Date | null;
  client_phone_e164: string | null;
  client_name: string | null;
  service_name: string;
  provider_name: string | null;
  amount_charged: number | null;
  status: string | null;
};

export type LegacyPlan = {
  rows: LegacyRow[];
  /** Filas que no se pudieron usar, con el motivo. Se imprimen, no se tragan. */
  skipped: { reason: "sin-fecha" | "sin-servicio" | "duplicada"; line: number }[];
};

/**
 * Las filas de `legacy_appointment`.
 *
 * ## `source_id` es obligatorio y no se inventa
 *
 * Es la llave de idempotencia: correr el import dos veces no puede duplicar el
 * pasado. Si el export no trae un id por cita, se deriva de la fila entera —
 * fecha + teléfono + servicio— y eso es determinista, pero **solo si el archivo
 * es el mismo**. Un export nuevo con una columna más produciría ids distintos y
 * duplicaría todo, así que el derivado usa un puñado de campos estables y no la
 * línea completa.
 *
 * ## El monto puede ser `null` y eso significa algo
 *
 * `null` es "el export no traía la plata", no "la cita fue gratis". Un cero
 * sería una mentira barata que después se suma en un reporte. Es la misma razón
 * por la que la columna nació nullable en la migración `014`.
 */
export function planLegacy(input: {
  rows: readonly RawRow[];
  /** Zona del estudio, para interpretar las fechas sin hora explícita. */
  parseDate: (raw: string) => Date | null;
}): LegacyPlan {
  const rows: LegacyRow[] = [];
  const skipped: LegacyPlan["skipped"] = [];
  const seen = new Set<string>();

  for (const [index, raw] of input.rows.entries()) {
    const line = index + 2; // +1 por el encabezado, +1 porque las líneas se cuentan desde 1.

    const started = raw.startedAt === undefined ? null : input.parseDate(raw.startedAt);
    if (started === null) {
      skipped.push({ reason: "sin-fecha", line });
      continue;
    }

    const serviceName = (raw.serviceName ?? "").trim();
    if (serviceName === "") {
      skipped.push({ reason: "sin-servicio", line });
      continue;
    }

    const phone = normalizePhoneE164(raw.phone ?? null);
    const { firstName, lastName } = splitName(raw.name, raw.lastName);
    const name = `${firstName} ${lastName}`.trim();

    const sourceId =
      raw.sourceId ?? deriveSourceId({ started, phone, serviceName, amount: raw.amount });

    // Un `source_id` repetido dentro del **mismo** archivo no es idempotencia:
    // es el export trayendo la misma cita dos veces. Pasa de verdad — el export
    // real trae una cita cancelada **triplicada**, fila por fila idéntica— y
    // colapsarlas es lo correcto. Se registra para que el conteo cuadre con lo
    // que alguien ve en Excel.
    if (seen.has(sourceId)) {
      skipped.push({ reason: "duplicada", line });
      continue;
    }
    seen.add(sourceId);

    rows.push({
      source_id: sourceId,
      started_at: started,
      ended_at: raw.endedAt === undefined ? null : input.parseDate(raw.endedAt),
      client_phone_e164: phone,
      client_name: name === "" ? null : name,
      service_name: serviceName,
      provider_name: raw.providerName ?? null,
      // El precio solo cuenta como plata si el cobro se concretó. `null` acá
      // significa "no hay un cobro que afirmar", que es lo mismo que significa
      // cuando el export no trae la columna: ninguno de los dos es cero.
      amount_charged: isPaid(raw.paidStatus) ? parseAmount(raw.amount) : null,
      status: raw.status ?? null,
    });
  }

  return { rows, skipped };
}

/** Id derivado, para un export sin columna de id. Estable entre corridas. */
function deriveSourceId(input: {
  started: Date;
  phone: string | null;
  serviceName: string;
  amount: string | undefined;
}): string {
  const stamp = input.started.toISOString().slice(0, 16);
  const who = input.phone ?? "sin-tel";
  const what = headerKey(input.serviceName).slice(0, 24);
  const howMuch = parseAmount(input.amount) ?? "";
  return `ap:${stamp}:${who}:${what}:${howMuch}`.slice(0, 64);
}

/**
 * El monto, en pesos enteros. `null` si no hay nada utilizable.
 *
 * Un export colombiano escribe `"$ 115.000"`, `"115.000,00"` o `"115000"`. El
 * punto es separador de miles y la coma es decimal, al revés que en inglés — y
 * Colombia no tiene centavos, así que los decimales se descartan en vez de
 * redondearse: `"115.000,50"` no existe como cobro real y aceptarlo como
 * 115.001 metería un peso fantasma en el reporte del año pasado.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;

  const cleaned = raw.replace(/[^\d,.-]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;

  const negative = cleaned.startsWith("-");
  // Se corta en la coma decimal y se tiran los puntos de miles. No se intenta
  // adivinar el formato mirando cuántos dígitos hay después del separador:
  // "1.500" es mil quinientos pesos en Colombia y adivinar lo volvería 1,5.
  const [integerPart] = cleaned.replace(/-/g, "").split(",");
  const digits = integerPart.replace(/\./g, "");
  if (digits === "") return null;

  const value = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(value)) return null;

  return negative ? -value : value;
}

// ---------------------------------------------------------------------------
// Las fechas
// ---------------------------------------------------------------------------

/**
 * La fecha de una cita del export → instante.
 *
 * ## Es la pieza más peligrosa del importador
 *
 * `03/04/2025` es el 3 de abril para Agenda Pro y el 4 de marzo para un parser
 * en inglés, y **las dos lecturas producen una fecha válida**. Un error acá no
 * falla: importa dos años de historia con los meses corridos, y se descubre
 * cuando alguien mira la ficha de una clienta y no reconoce sus citas.
 *
 * Por eso el orden es explícito y no se deduce: **día primero**, que es lo que
 * usa Colombia y lo que exporta una herramienta en español. Un formato ISO
 * (`2025-04-03`) se reconoce aparte por su forma, porque ahí no hay ambigüedad.
 *
 * ## La hora es hora de pared de Bogotá
 *
 * El export dice "14:00" y eso significa las dos de la tarde en el estudio, no
 * en UTC. Se convierte con la misma función que usa el resto del panel, así que
 * una cita de las 2 p. m. de hace un año se lee a las 2 p. m. — incluso si
 * alguna vez cambiara el offset del país.
 *
 * ## Sin hora, mediodía
 *
 * Un export que solo trae la fecha se ancla a las 12:00 y no a las 00:00. A
 * medianoche, cualquier corrimiento de un par de horas cruza al día anterior y
 * la cita aparece un día antes en la ficha; al mediodía no hay margen de error
 * que alcance para cambiar de día.
 */
export function parseAgendaproDate(raw: string, timeZone: string = EA_TIME_ZONE): Date | null {
  const value = raw.trim();
  if (value === "") return null;

  const match =
    // ISO: 2025-04-03, con hora opcional y con "T" o espacio.
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value) ??
    null;

  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    return build(Number(y), Number(m), Number(d), hh, mm, ss, timeZone);
  }

  // Día primero: 3/4/2025, 03-04-2025, 3.4.2025 — con hora opcional y con
  // a. m./p. m. opcional.
  const dmy =
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([ap])\.?\s*m?\.?/i.exec(
      value,
    ) ??
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
      value,
    );

  if (!dmy) return null;

  const [, d, m, rawYear, hh, mm, ss, meridiem] = dmy;

  // Un año de dos cifras es del siglo XXI: el estudio no tiene historia de 1998.
  const year = rawYear.length <= 2 ? 2000 + Number(rawYear) : Number(rawYear);

  let hour = hh === undefined ? undefined : Number(hh);
  if (hour !== undefined && meridiem) {
    const pm = meridiem.toLowerCase() === "p";
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }

  return build(
    year,
    Number(m),
    Number(d),
    hour === undefined ? undefined : String(hour),
    mm,
    ss,
    timeZone,
  );
}

function build(
  year: number,
  month: number,
  day: number,
  hh: string | undefined,
  mm: string | undefined,
  ss: string | undefined,
  timeZone: string,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Sin hora: mediodía. Ver la nota de arriba.
  const hour = hh === undefined ? 12 : Number(hh);
  const minute = mm === undefined ? 0 : Number(mm);
  const second = ss === undefined ? 0 : Number(ss);

  if (hour > 23 || minute > 59 || second > 59) return null;

  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const wall = `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;

  try {
    const instant = eaLocalToInstant(parseEaLocalDateTime(wall), timeZone);
    // El 31 de febrero parsea como 3 de marzo en la aritmética de fechas. Se
    // verifica que el día sobreviva el viaje de ida y vuelta: una fecha que no
    // existe en el calendario es un error del export, no una cita.
    const back = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
    return back === `${pad(year, 4)}-${pad(month)}-${pad(day)}` ? instant : null;
  } catch {
    return null;
  }
}
