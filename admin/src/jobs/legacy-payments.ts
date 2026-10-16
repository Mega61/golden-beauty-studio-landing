/**
 * Los pagos del historial de Agenda Pro: leer los reportes de plata, juntarlos
 * y casar cada pago con su reserva de `legacy_appointment`.
 *
 * ## Por qué hace falta
 *
 * `legacy_appointment` sale del reporte de **reservas**, que dice cuánto se
 * cobró pero no cómo. La dueña quiere ver efectivo contra transferencia y las
 * propinas del tiempo de Agenda Pro, y eso solo está en los reportes de plata:
 *
 * - **Ventas** (`ventas_*.xlsx`): hojas "Resumen", "Ventas", "Ítems" y
 *   "Transacciones". "Ítems" es la que trae cliente, servicio, prestador y
 *   **fecha de la reserva** — lo que deja casar el pago con su cita.
 * - **Transacciones** (`transacciones_*.xlsx`): una sola hoja con las mismas
 *   columnas que la "Transacciones" de arriba.
 *
 * Agenda Pro corta esos reportes en ~1 mes, así que llegan por tramos que se
 * pisan: el mismo pago aparece en dos archivos (y en las dos clases de
 * reporte). La llave es el "ID" de la transacción; se queda la primera vez.
 *
 * ## Las columnas se leen por encabezado, y las celdas por su referencia
 *
 * Excel omite las celdas vacías en el XML. Un lector que las cuente por orden
 * corre los valores a la izquierda — así fue como "Método de Pago" pareció
 * venir todo en "-" cuando el método estaba en la columna de al lado. `xlsx.ts`
 * ubica cada celda por su `r="H7"`, y acá cada campo se busca por el nombre de
 * su encabezado (el mismo mapeo que usa el CRM con SheetJS), nunca por número
 * de columna.
 *
 * ## "Método de Pago", no "Comprobante"
 *
 * Mirado en los archivos reales (2026-05 a 2026-10, 182 pagos): "Método de
 * Pago" trae "Efectivo" / "Transferencia Bancaria" en todas las filas y
 * "Comprobante" viene vacío en todas. El método sale de "Método de Pago"; si
 * algún export lo trajera vacío o en "-", se mira "Comprobante" antes de
 * rendirse a `otro`. La normalización es la del CRM (`mapPaymentMethod`):
 * contiene "efectivo" → efectivo; "transferencia", "bancolombia" o "nequi" →
 * transferencia; cualquier otra cosa → otro.
 *
 * ## Cómo se casa un pago con su reserva
 *
 * Agenda Pro no comparte un id entre el reporte de reservas y los de plata
 * (el "ID pago" de reservas no llegó a `legacy_appointment`). Se casa **por
 * venta** —todos los pagos de una venta van a la misma reserva— y con dos
 * reglas, en orden:
 *
 * 1. **`reserva`**: la "Fecha reserva" del ítem cae en el mismo minuto que el
 *    inicio de la cita, y es la misma persona (nombre normalizado igual, o
 *    —si eso no alcanza— el mismo nombre de pila y una sola cita así en ese
 *    minuto).
 * 2. **`respaldo`**: mismo día, mismo monto y mismo servicio, y una sola cita
 *    que cumpla las tres.
 *
 * Una cita se enlaza a una sola venta. Lo que no casa queda con
 * `legacy_appointment_id = NULL` y se cuenta: **no se adivina**. Un enlace
 * equivocado le pondría a una clienta el método de pago de otra.
 *
 * ## ⚠ Esto no es un camino de plata
 *
 * Esa plata ya está en Actual Budget (scraper de Agenda Pro, `agendapro-tx:<id>`).
 * `legacy_payment` es para pantalla; ver `lib/legacy-history.money-paths.test.ts`.
 */

import { z } from "zod";

import type { PaymentMethod } from "@/db/types";
import { eaDatePart, type EaLocalDateTime } from "@/lib/ea";
import { normalizeName } from "@/lib/legacy-history";

import { headerKey, parseAmount } from "./import-agendapro";

// ---------------------------------------------------------------------------
// Método de pago
// ---------------------------------------------------------------------------

/**
 * El texto de Agenda Pro → uno de los tres métodos del panel.
 *
 * El mismo criterio que `mapPaymentMethod` del CRM, para que los dos sistemas
 * cuenten igual el mismo archivo.
 */
export function normalizePaymentMethod(raw: string | null | undefined): PaymentMethod {
  const value = normalizeName(raw);
  if (value.includes("efectivo")) return "efectivo";
  if (value.includes("transferencia") || value.includes("bancolombia") || value.includes("nequi")) {
    return "transferencia";
  }
  return "otro";
}

/** Un valor que Agenda Pro escribe para decir "nada": vacío o un guion. */
function blank(value: string | undefined): boolean {
  return value === undefined || /^[\s\-–—]*$/.test(value);
}

// ---------------------------------------------------------------------------
// Hojas
// ---------------------------------------------------------------------------

type Table = readonly (readonly string[])[];

/** Encabezado → índice, por llave normalizada. La primera aparición gana. */
function headerIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    if (key !== "" && !map.has(key)) map.set(key, index);
  });
  return map;
}

/** Qué hoja es, por sus encabezados y no por su nombre ni su posición. */
export type SheetKind = "transacciones" | "ventas" | "items";

export function sheetKind(header: readonly string[]): SheetKind | null {
  const keys = new Set(header.map(headerKey));
  if (keys.has("idventa") && keys.has("monto") && [...keys].some((k) => k.startsWith("metododepago"))) {
    return "transacciones";
  }
  if (keys.has("idventa") && keys.has("nombreitem")) return "items";
  if (keys.has("montoventa") && keys.has("id")) return "ventas";
  return null;
}

function cell(row: readonly string[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  const value = row[index];
  return value === undefined ? undefined : value.trim();
}

/**
 * El id de una venta, comparable. Agenda Pro escribe algunos como `"#1003"` y
 * otros como `"1003"` —en los archivos reales, las ventas viejas traen el
 * numeral—, y las correcciones de la dueña los escriben sin él. Sin esto, la
 * misma venta serían dos.
 */
export function saleIdKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/^#\s*/, "");
  return value === "" ? null : value;
}

/** El primer encabezado cuya llave empieza así ("Método de Pago (1)" también). */
function startsWithKey(index: Map<string, number>, prefix: string): number | undefined {
  for (const [key, at] of index) if (key.startsWith(prefix)) return at;
  return undefined;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/**
 * `"19/09/2026 14:12"` → `"2026-09-19 14:12:00"`, hora de pared de Bogotá tal
 * cual la escribió Agenda Pro. **Día primero**, como en el import de reservas
 * (`parseAgendaproDate`), y sin pasar por ninguna zona: el casado con la
 * reserva compara horas de pared, y cualquier conversión de por medio es donde
 * nace el corrimiento de cinco horas.
 */
export function agendaproWallClock(raw: string | undefined): EaLocalDateTime | null {
  const value = (raw ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  let parts: [number, number, number, number, number, number];
  if (iso) {
    parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 12), Number(iso[5] ?? 0), Number(iso[6] ?? 0)];
  } else if (dmy) {
    parts = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), Number(dmy[4] ?? 12), Number(dmy[5] ?? 0), Number(dmy[6] ?? 0)];
  } else {
    return null;
  }
  const [year, month, day, hour, minute, second] = parts;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  // El 31 de febrero no existe: se rechaza en vez de dejar que la aritmética
  // de fechas lo convierta en 3 de marzo.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` as EaLocalDateTime;
}

// ---------------------------------------------------------------------------
// Leer y juntar
// ---------------------------------------------------------------------------

/** Un pago ya leído, juntado con su venta y sus ítems. Todo en hora de pared. */
export type ParsedPayment = {
  sourceTxId: string;
  saleId: string | null;
  paidAt: EaLocalDateTime;
  /** Pesos enteros, sin la propina. */
  amount: number;
  tip: number;
  method: PaymentMethod;
  /** Lo que decía Agenda Pro, para revisar la normalización. */
  methodRaw: string | null;
  clientName: string | null;
  /** Los ítems de la venta, separados por " + " si hay varios. */
  serviceName: string | null;
  providerName: string | null;
  /** "Fecha reserva" del ítem: cuándo era la cita, no cuándo se pagó. */
  bookedAt: EaLocalDateTime | null;
};

export type PaymentSkip = { reason: "sin-id" | "sin-fecha" | "sin-monto"; file: string; line: number };

export type ParsedPayments = {
  payments: ParsedPayment[];
  skipped: PaymentSkip[];
  /** Pagos que aparecieron en más de un archivo (los tramos se pisan). */
  duplicates: number;
  /**
   * Repetidos **con datos distintos** entre archivos (monto o método). Se
   * queda el primero y se avisa: no debería pasar, y si pasa hay que mirarlo.
   */
  conflicts: string[];
  /** Pagos cuya venta no apareció en ninguna hoja "Ventas"/"Ítems". */
  withoutSale: number;
};

type SaleInfo = {
  clientName: string | null;
  services: string[];
  providerName: string | null;
  bookedAt: EaLocalDateTime | null;
};

/** Una hoja de un archivo, con su nombre de archivo para los avisos. */
export type SourceSheet = { file: string; rows: Table };

/**
 * Todas las hojas de todos los archivos → los pagos, sin repetidos.
 *
 * Las hojas se clasifican por encabezado (`sheetKind`), así da igual si
 * vienen del reporte de ventas o del de transacciones, y "Resumen" se ignora
 * sola. Las ventas y los ítems se indexan por **"ID interno"** de la venta,
 * que es lo que la columna "ID Venta" de "Ítems" y "Transacciones" referencia
 * (verificado: venta `ID 47249996` / `ID interno 1140` ↔ ítem y transacción
 * con `ID Venta 1140`). Por si algún export usara el otro, se indexa también
 * por "ID".
 */
export function parsePaymentSheets(sheets: readonly SourceSheet[]): ParsedPayments {
  const sales = new Map<string, SaleInfo>();
  const saleIdAlias = new Map<string, string>();

  const saleOf = (id: string): SaleInfo => {
    const key = saleIdAlias.get(id) ?? id;
    let info = sales.get(key);
    if (!info) {
      info = { clientName: null, services: [], providerName: null, bookedAt: null };
      sales.set(key, info);
    }
    return info;
  };

  // Primero ventas e ítems de todos los archivos: un pago del reporte de
  // transacciones se completa con el ítem del reporte de ventas del mismo tramo.
  const seenItems = new Set<string>();
  for (const sheet of sheets) {
    const [header, ...body] = sheet.rows;
    if (header === undefined) continue;
    const kind = sheetKind(header);
    const index = headerIndex(header);

    if (kind === "ventas") {
      for (const row of body) {
        const internal = saleIdKey(cell(row, index.get("idinterno")));
        const id = saleIdKey(cell(row, index.get("id")));
        const key = internal || id;
        if (!key) continue;
        if (id && internal) saleIdAlias.set(id, internal);
        const info = saleOf(key);
        info.clientName ??= cell(row, index.get("cliente")) || null;
      }
    }

    if (kind === "items") {
      for (const row of body) {
        const saleId = saleIdKey(cell(row, index.get("idventa")));
        if (!saleId) continue;
        const name = cell(row, index.get("nombreitem")) || "";
        const booked = cell(row, index.get("fechareserva"));
        // El mismo ítem llega en dos tramos que se pisan: se cuenta una vez.
        const itemKey = `${saleId}|${name}|${booked ?? ""}|${cell(row, index.get("total")) ?? ""}`;
        if (seenItems.has(itemKey)) continue;
        seenItems.add(itemKey);

        const info = saleOf(saleId);
        if (name !== "") info.services.push(name);
        info.clientName ??= cell(row, index.get("cliente")) || null;
        info.providerName ??= cell(row, index.get("prestador")) || null;
        info.bookedAt ??= agendaproWallClock(booked);
      }
    }
  }

  const payments = new Map<string, ParsedPayment>();
  const skipped: PaymentSkip[] = [];
  const conflicts: string[] = [];
  let duplicates = 0;
  let withoutSale = 0;

  for (const sheet of sheets) {
    const [header, ...body] = sheet.rows;
    if (header === undefined || sheetKind(header) !== "transacciones") continue;
    const index = headerIndex(header);
    const methodAt = startsWithKey(index, "metododepago");

    body.forEach((row, offset) => {
      const line = offset + 2;
      if (row.every((value) => value.trim() === "")) return;

      const txId = cell(row, index.get("id"));
      if (!txId) {
        skipped.push({ reason: "sin-id", file: sheet.file, line });
        return;
      }
      const paidAt = agendaproWallClock(cell(row, index.get("fecha")));
      if (paidAt === null) {
        skipped.push({ reason: "sin-fecha", file: sheet.file, line });
        return;
      }
      const amount = parseAmount(cell(row, index.get("monto")));
      if (amount === null) {
        skipped.push({ reason: "sin-monto", file: sheet.file, line });
        return;
      }

      const methodCell = cell(row, methodAt);
      const voucher = cell(row, index.get("comprobante"));
      const methodRaw = !blank(methodCell) ? methodCell! : !blank(voucher) ? voucher! : null;
      const method = normalizePaymentMethod(methodRaw);

      const existing = payments.get(txId);
      if (existing) {
        duplicates += 1;
        if (existing.amount !== amount || existing.method !== method) conflicts.push(txId);
        return;
      }

      const saleId = saleIdKey(cell(row, index.get("idventa")));
      const sale = saleId === null ? undefined : sales.get(saleIdAlias.get(saleId) ?? saleId);
      if (sale === undefined) withoutSale += 1;

      payments.set(txId, {
        sourceTxId: txId,
        saleId: saleId === null ? null : (saleIdAlias.get(saleId) ?? saleId),
        paidAt,
        amount,
        tip: parseAmount(cell(row, index.get("propina"))) ?? 0,
        method,
        methodRaw,
        clientName: sale?.clientName ?? null,
        serviceName: sale && sale.services.length > 0 ? sale.services.join(" + ") : null,
        providerName: sale?.providerName ?? null,
        bookedAt: sale?.bookedAt ?? null,
      });
    });
  }

  // Orden estable: por fecha de pago y luego por id. Dos corridas sobre los
  // mismos archivos dan el mismo plan, en el orden que sea que lleguen.
  const sorted = [...payments.values()].sort(
    (a, b) => a.paidAt.localeCompare(b.paidAt) || a.sourceTxId.localeCompare(b.sourceTxId),
  );

  return { payments: sorted, skipped, duplicates, conflicts, withoutSale };
}

// ---------------------------------------------------------------------------
// Casar con la reserva
// ---------------------------------------------------------------------------

/** Una fila de `legacy_appointment`, en hora de pared. */
export type LegacyCandidate = {
  id: number;
  start: EaLocalDateTime;
  clientName: string | null;
  serviceName: string;
  amountCharged: number | null;
};

export type MatchRule = "reserva" | "respaldo";

export type PaymentMatch = {
  /** `sourceTxId` → id de `legacy_appointment`, o `null` si no casó. */
  links: Map<string, number | null>;
  /** Pagos casados por cada regla. */
  byRule: Record<MatchRule, number>;
  matched: number;
  unmatched: number;
  /** Plata de los pagos que no casaron, para saber cuánto pesa lo suelto. */
  unmatchedAmount: number;
};

/**
 * Un nombre de cliente comparable: sin tildes, sin mayúsculas, sin signos, y
 * sin los rellenos que Agenda Pro deja en el apellido ("Ana _"). El import de
 * reservas ya los borró del lado de `legacy_appointment` (`splitName`), así
 * que hay que borrarlos de este lado para que "Ana _" y "Ana" sean la misma.
 */
export function clientNameKey(value: string | null | undefined): string {
  return normalizeName(value)
    // "N/A" antes de borrar signos: después serían dos letras sueltas.
    .replace(/(^|\s)n\/a(?=\s|$)/g, " ")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .split(" ")
    .filter((token) => token !== "" && !/^(na|nn|sin|ninguno)$/.test(token))
    .join(" ");
}

function minute(value: EaLocalDateTime): string {
  return value.slice(0, 16);
}

/**
 * Cada pago → su cita de `legacy_appointment`, por venta. Ver la cabecera para
 * las dos reglas y por qué no se adivina.
 */
export function matchPayments(
  payments: readonly ParsedPayment[],
  legacy: readonly LegacyCandidate[],
): PaymentMatch {
  // Una venta = un grupo de pagos. Sin id de venta, el pago es su propio grupo.
  const sales = new Map<string, ParsedPayment[]>();
  for (const payment of payments) {
    const key = payment.saleId === null ? `tx:${payment.sourceTxId}` : `sale:${payment.saleId}`;
    const group = sales.get(key) ?? [];
    group.push(payment);
    sales.set(key, group);
  }

  const used = new Set<number>();
  const links = new Map<string, number | null>();
  const byRule: Record<MatchRule, number> = { reserva: 0, respaldo: 0 };
  let unmatchedAmount = 0;

  const byMinute = new Map<string, LegacyCandidate[]>();
  const byDay = new Map<string, LegacyCandidate[]>();
  for (const row of legacy) {
    const m = byMinute.get(minute(row.start)) ?? [];
    m.push(row);
    byMinute.set(minute(row.start), m);
    const d = byDay.get(eaDatePart(row.start)) ?? [];
    d.push(row);
    byDay.set(eaDatePart(row.start), d);
  }

  const only = (rows: readonly LegacyCandidate[]): LegacyCandidate | null => (rows.length === 1 ? rows[0] : null);

  // Se resuelven primero todas las de la regla fuerte y después las de
  // respaldo: así una venta que solo casa por respaldo no le quita la cita a
  // otra que la reclamaba por fecha de reserva y nombre.
  const pending: [string, ParsedPayment[]][] = [];
  for (const [key, group] of sales) {
    const first = group[0];
    let found: LegacyCandidate | null = null;

    if (first.bookedAt !== null) {
      const atMinute = (byMinute.get(minute(first.bookedAt)) ?? []).filter((row) => !used.has(row.id));
      const name = clientNameKey(first.clientName);
      if (name !== "") {
        found = only(atMinute.filter((row) => clientNameKey(row.clientName) === name));
        if (found === null) {
          const given = name.split(" ")[0];
          found = only(atMinute.filter((row) => clientNameKey(row.clientName).split(" ")[0] === given));
        }
      }
    }

    if (found !== null) {
      used.add(found.id);
      byRule.reserva += group.length;
      for (const payment of group) links.set(payment.sourceTxId, found.id);
    } else {
      pending.push([key, group]);
    }
  }

  for (const [, group] of pending) {
    const first = group[0];
    const total = group.reduce((sum, payment) => sum + payment.amount, 0);
    const service = normalizeName(first.serviceName);
    const day = eaDatePart(first.bookedAt ?? first.paidAt);

    const found =
      service === ""
        ? null
        : only(
            (byDay.get(day) ?? []).filter(
              (row) =>
                !used.has(row.id) &&
                row.amountCharged === total &&
                normalizeName(row.serviceName) === service,
            ),
          );

    if (found !== null) {
      used.add(found.id);
      byRule.respaldo += group.length;
      for (const payment of group) links.set(payment.sourceTxId, found.id);
    } else {
      for (const payment of group) {
        links.set(payment.sourceTxId, null);
        unmatchedAmount += payment.amount;
      }
    }
  }

  const matched = byRule.reserva + byRule.respaldo;
  return { links, byRule, matched, unmatched: payments.length - matched, unmatchedAmount };
}

// ---------------------------------------------------------------------------
// Correcciones de la dueña
// ---------------------------------------------------------------------------

/**
 * Lo que Agenda Pro dijo y no era cierto, corregido por la dueña en Actual
 * Budget y traído a un archivo aparte (`--correcciones=<archivo.json>`).
 *
 * Solo ids de transacción, nunca datos de clientas. Lo que no está listado se
 * queda **exactamente** como lo dijo Agenda Pro. Tres clases:
 *
 * - `method`: el medio real. A veces se marcó "Transferencia" una venta en
 *   efectivo, y una vez al revés.
 * - `split`: un pago que en la realidad fueron dos medios. Se guarda como dos
 *   filas (`part` 0 y 1) de la misma transacción; las partes tienen que sumar
 *   **exactamente** el monto de Agenda Pro, o no se importa nada.
 * - `courtesy`: venta de cortesía (la dueña, su hermana, Juan). No entró
 *   plata; sí fue trabajo de la técnica y su comisión (pagada por fuera del
 *   panel) se calculó sobre ella. Los reportes la sacan de ventas, del reparto
 *   y del ticket, y la muestran aparte.
 *
 * `sale` es la venta que la dueña tenía a la vista al corregir: si no coincide
 * con la del archivo, la corrección apunta a otra cosa y se avisa.
 */
export type Correction = {
  sale: string | null;
  method?: PaymentMethod;
  split?: { method: PaymentMethod; amount: number }[];
  courtesy: boolean;
};

export type Corrections = ReadonlyMap<string, Correction>;

export class CorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionError";
  }
}

const METHOD = z.enum(["efectivo", "transferencia", "otro"]);
const CORRECTIONS = z.object({
  tx: z.record(
    z.string().regex(/^\d+$/, "el id de transacción son solo dígitos"),
    z
      .object({
        sale: z.string().optional(),
        method: METHOD.optional(),
        split: z
          .array(z.object({ method: METHOD, amount: z.number().int().positive() }))
          .min(2, "un pago partido tiene por lo menos dos partes")
          .max(9)
          .optional(),
        courtesy: z.boolean().optional(),
      })
      .strict()
      .refine((entry) => !(entry.method && entry.split), {
        message: "`method` y `split` a la vez: ¿cuál es el medio?",
      }),
  ),
});

/** El JSON del archivo → correcciones, o un error que dice qué está mal. */
export function parseCorrections(json: unknown): Corrections {
  const parsed = CORRECTIONS.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CorrectionError(
      `el archivo de correcciones no tiene la forma esperada (${issue.path.join(".")}: ${issue.message}).`,
    );
  }
  return new Map(
    Object.entries(parsed.data.tx).map(([tx, entry]) => [
      tx,
      {
        sale: entry.sale ?? null,
        ...(entry.method ? { method: entry.method } : {}),
        ...(entry.split ? { split: entry.split } : {}),
        courtesy: entry.courtesy === true,
      },
    ]),
  );
}

/** Un pago listo para escribir: una fila de `legacy_payment`. */
export type PlannedPayment = Omit<ParsedPayment, "method"> & {
  /** `0`, o `0`/`1`… en un pago partido. */
  part: number;
  /** El medio real: el de la corrección, o el de Agenda Pro si no hay. */
  method: PaymentMethod;
  /** El que dijo Agenda Pro, para auditar. */
  methodAgendapro: PaymentMethod;
  isCourtesy: boolean;
};

export type CorrectionReport = {
  /** Transacciones cuyo medio real difiere del de Agenda Pro. */
  methodChanged: number;
  split: number;
  courtesy: number;
  /** Correcciones cuyo id no apareció en los archivos. */
  notFound: string[];
  /** Correcciones cuya venta no coincide con la del archivo. */
  saleMismatch: string[];
};

/**
 * Pagos de Agenda Pro + correcciones → las filas a escribir.
 *
 * Lanza `CorrectionError` si un pago partido no suma el monto de Agenda Pro:
 * importar "más o menos" la plata de una venta es justo lo que las
 * correcciones existen para evitar.
 */
export function applyCorrections(
  payments: readonly ParsedPayment[],
  corrections: Corrections = new Map(),
): { rows: PlannedPayment[]; report: CorrectionReport } {
  const rows: PlannedPayment[] = [];
  const report: CorrectionReport = { methodChanged: 0, split: 0, courtesy: 0, notFound: [], saleMismatch: [] };
  const seen = new Set<string>();

  for (const payment of payments) {
    const { method: agendapro, ...rest } = payment;
    const fix = corrections.get(payment.sourceTxId);
    if (fix === undefined) {
      rows.push({ ...rest, part: 0, method: agendapro, methodAgendapro: agendapro, isCourtesy: false });
      continue;
    }

    seen.add(payment.sourceTxId);
    const expected = saleIdKey(fix.sale);
    if (expected !== null && payment.saleId !== null && expected !== payment.saleId) {
      report.saleMismatch.push(payment.sourceTxId);
    }
    if (fix.courtesy) report.courtesy += 1;

    if (fix.split) {
      const sum = fix.split.reduce((total, part) => total + part.amount, 0);
      if (sum !== payment.amount) {
        throw new CorrectionError(
          `la transacción ${payment.sourceTxId} se parte en $${sum.toLocaleString("es-CO")} y Agenda Pro dice ` +
            `$${payment.amount.toLocaleString("es-CO")}: las partes tienen que sumar exacto.`,
        );
      }
      report.split += 1;
      if (fix.split.some((part) => part.method !== agendapro)) report.methodChanged += 1;
      fix.split.forEach((part, index) => {
        rows.push({
          ...rest,
          part: index,
          amount: part.amount,
          // La propina es una sola: va con la primera parte, no se reparte.
          tip: index === 0 ? payment.tip : 0,
          method: part.method,
          methodAgendapro: agendapro,
          isCourtesy: fix.courtesy,
        });
      });
      continue;
    }

    const method = fix.method ?? agendapro;
    if (method !== agendapro) report.methodChanged += 1;
    rows.push({ ...rest, part: 0, method, methodAgendapro: agendapro, isCourtesy: fix.courtesy });
  }

  report.notFound = [...corrections.keys()].filter((tx) => !seen.has(tx)).sort();
  return { rows, report };
}

// ---------------------------------------------------------------------------
// Resumen para la ejecución en seco
// ---------------------------------------------------------------------------

type ByMethod = Record<PaymentMethod, number>;

export type PaymentTotals = {
  /** Transacciones de Agenda Pro (un pago partido cuenta una vez). */
  transactions: number;
  /** Todo lo que Agenda Pro registró, cortesías incluidas. */
  gross: number;
  courtesy: { transactions: number; amount: number };
  /** Lo que entró de verdad: bruto menos cortesías. */
  net: number;
  tips: number;
  /** Lo neto, por medio real (después de las correcciones). */
  netByMethod: ByMethod;
  /** `"YYYY-MM"` → lo mismo, por fecha de pago. En orden. */
  byMonth: {
    month: string;
    transactions: number;
    gross: number;
    courtesy: number;
    net: number;
    tips: number;
    netByMethod: ByMethod;
  }[];
};

/**
 * Bruto, cortesías, neto y neto por medio, en total y por mes. Es lo que el
 * CLI imprime antes de escribir, para cotejarlo con Actual Budget.
 */
export function paymentTotals(rows: readonly PlannedPayment[]): PaymentTotals {
  const empty = (): ByMethod => ({ efectivo: 0, transferencia: 0, otro: 0 });
  const months = new Map<string, PaymentTotals["byMonth"][number] & { txs: Set<string> }>();
  const txs = new Set<string>();
  const courtesyTxs = new Set<string>();
  const totals = { gross: 0, courtesy: 0, tips: 0, netByMethod: empty() };

  for (const row of rows) {
    const month = row.paidAt.slice(0, 7);
    const entry =
      months.get(month) ??
      { month, transactions: 0, gross: 0, courtesy: 0, net: 0, tips: 0, netByMethod: empty(), txs: new Set<string>() };
    months.set(month, entry);

    txs.add(row.sourceTxId);
    entry.txs.add(row.sourceTxId);
    totals.gross += row.amount;
    entry.gross += row.amount;
    totals.tips += row.tip;
    entry.tips += row.tip;

    if (row.isCourtesy) {
      courtesyTxs.add(row.sourceTxId);
      totals.courtesy += row.amount;
      entry.courtesy += row.amount;
    } else {
      totals.netByMethod[row.method] += row.amount;
      entry.netByMethod[row.method] += row.amount;
    }
  }

  return {
    transactions: txs.size,
    gross: totals.gross,
    courtesy: { transactions: courtesyTxs.size, amount: totals.courtesy },
    net: totals.gross - totals.courtesy,
    tips: totals.tips,
    netByMethod: totals.netByMethod,
    byMonth: [...months.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(({ txs: monthTxs, ...entry }) => ({
        ...entry,
        transactions: monthTxs.size,
        net: entry.gross - entry.courtesy,
      })),
  };
}
