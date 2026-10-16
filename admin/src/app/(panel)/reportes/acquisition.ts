/**
 * Costo por clienta nueva — "si la pauta se paga sola".
 *
 * Funciones puras, como el resto de los reportes. Las dos cifras que cruza
 * vienen de lugares que ya existían y **no se redefinen acá**:
 *
 * - **Clienta nueva** es `splitCustomers()` de `lib/metrics.ts`, llamada con
 *   la misma unión EA + `legacy_appointment` que usa "Clientas nuevas vs. que
 *   vuelven". Si este reporte contara nuevas a su manera, los dos dirían
 *   números distintos para el mismo mes en la misma pantalla.
 * - **Lo que pagaron** es `amount_charged` de las cuentas cerradas, el precio
 *   congelado. Nada se recalcula con la lista de hoy.
 *
 * Lo único nuevo es la inversión en anuncios (`ad_spend`, migración `023`),
 * que la dueña anota a mano por mes.
 *
 * ## Periodos que no son meses enteros: se suma el mes completo, y se dice
 *
 * La inversión se conoce por mes. Un periodo del 10 al 25 tiene dos salidas:
 * prorratear la factura por días, o sumar los meses que toca. Prorratear se ve
 * más preciso y no lo es —la pauta no se gasta pareja, un anuncio de fin de
 * mes trae clientas el mes siguiente— y además fabrica una cifra que nadie
 * pagó. Así que se suman **los meses completos** que el periodo toca y la
 * pantalla lo dice cuando el periodo no los cubre enteros. Con la cadencia
 * mensual —que es la de este reporte— el caso ni aparece.
 *
 * ## Dividir por cero no da un número
 *
 * Sin inversión registrada, sin pauta, o sin clientas nuevas, el costo por
 * clienta es `null` con el motivo, nunca `Infinity` ni `$ 0`. Un "$ 0 por
 * clienta" el mes que nadie anotó la factura diría que la pauta es gratis.
 */

import type { AdChannel, Cop } from "@/db/types";
import { splitCustomers, type DateRange, type VisitRecord } from "@/lib/metrics";

import { isPaidTicket, type FinanceRow } from "./aggregate";
import { daysInMonth } from "./period";

export const AD_CHANNELS: readonly AdChannel[] = ["meta", "google", "otro"];

export const AD_CHANNEL_LABEL: Record<AdChannel, string> = {
  meta: "Meta (Instagram y Facebook)",
  google: "Google",
  otro: "Otro",
};

/** Tope de cordura del formulario: cien millones de pesos en un mes y un canal. */
export const AD_SPEND_MAX = 100_000_000;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `"2026-08"` válido, o `null`. Nunca lanza: lo escribe una persona. */
export function parseMonth(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return MONTH_RE.test(value) ? value : null;
}

/** Los meses `"YYYY-MM"` que toca un rango, en orden y sin repetir. */
export function monthsInPeriod(period: DateRange): string[] {
  const [fy, fm] = period.from.split("-").map(Number);
  const [ty, tm] = period.to.split("-").map(Number);
  const out: string[] = [];
  for (let serial = fy * 12 + (fm - 1); serial <= ty * 12 + (tm - 1); serial += 1) {
    const y = Math.floor(serial / 12);
    const m = (serial % 12) + 1;
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

/** Los meses del rango que el periodo **no** cubre enteros. */
export function partialMonths(period: DateRange): string[] {
  const months = monthsInPeriod(period);
  return months.filter((month) => {
    const [y, m] = month.split("-").map(Number);
    const first = `${month}-01`;
    const last = `${month}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
    return period.from > first || period.to < last;
  });
}

export type AdSpendEntry = { month: string; channel: AdChannel; amountCop: Cop };

/** Por qué no hay costo por clienta, cuando no lo hay. */
export type AcquisitionState =
  /** Hay inversión y hay clientas nuevas: el costo existe. */
  | "ok"
  /** No hay ninguna fila de `ad_spend` para los meses del periodo. */
  | "sin-inversion"
  /** Hay filas y suman cero: se anotó que ese mes no se pautó. */
  | "sin-pauta"
  /** Hubo inversión y ninguna clienta nueva. */
  | "sin-clientas"
  /** `ad_spend` no se pudo leer (la migración `023` no está, o la base no respondió). */
  | "sin-lectura";

export type AcquisitionReport = {
  state: AcquisitionState;
  newCustomers: number;
  /** `null` = no se sabe (sin filas o sin lectura). **No es cero.** */
  spend: Cop | null;
  /** Por canal, para la tabla. Solo los canales con fila. */
  byChannel: { channel: AdChannel; amount: Cop }[];
  months: string[];
  /** Meses que el periodo toca sin cubrirlos enteros. Su inversión entra completa. */
  partialMonths: string[];
  /** Meses del periodo sin ninguna fila: la cifra puede estar incompleta. */
  missingMonths: string[];
  /** `spend / newCustomers`, a peso entero. `null` con el motivo en `state`. */
  costPerNew: Cop | null;
  /** Lo que las clientas nuevas pagaron en el periodo (cuentas cerradas). */
  revenueFromNew: Cop;
  /** Cuántas de las nuevas ya tienen al menos una cuenta cerrada. */
  newWithRevenue: number;
  /** `revenueFromNew / spend`. `1` = la pauta ya se pagó. `null` sin inversión. */
  recovered: number | null;
};

export function acquisitionReport(input: {
  period: DateRange;
  /** La unión EA + legacy, **las dos juntas** — lo pide `splitCustomers()`. */
  visits: readonly VisitRecord[];
  /** Cuentas del periodo. */
  finance: readonly FinanceRow[];
  /** `ea_appointment_id → teléfono E.164` de las citas del periodo. */
  customerOf: ReadonlyMap<number, string | null>;
  /** `null` = la tabla no se pudo leer. */
  adSpend: readonly AdSpendEntry[] | null;
}): AcquisitionReport {
  const months = monthsInPeriod(input.period);
  const { newCustomers } = splitCustomers(input.visits, input.period);
  const fresh = new Set(newCustomers);

  // Plata de las nuevas: cuentas cerradas del periodo cuya cita es de una de
  // ellas. Todas sus visitas del periodo son de su primera en adelante —es lo
  // que las hace nuevas—, así que no hace falta filtrar por fecha.
  let revenueFromNew = 0;
  const paying = new Set<string>();
  for (const row of input.finance) {
    // Una cortesía de la casa no es una clienta que pagó.
    if (!isPaidTicket(row) || row.amountCharged === null || row.startAt === null) continue;
    const day = row.startAt.slice(0, 10);
    if (day < input.period.from || day > input.period.to) continue;
    const customer = input.customerOf.get(row.eaAppointmentId) ?? null;
    if (customer === null || !fresh.has(customer)) continue;
    revenueFromNew += row.amountCharged;
    paying.add(customer);
  }

  const base = {
    newCustomers: newCustomers.length,
    months,
    partialMonths: partialMonths(input.period),
    revenueFromNew,
    newWithRevenue: paying.size,
  };

  if (input.adSpend === null) {
    return {
      ...base,
      state: "sin-lectura",
      spend: null,
      byChannel: [],
      missingMonths: [],
      costPerNew: null,
      recovered: null,
    };
  }

  const inPeriod = input.adSpend.filter((row) => months.includes(row.month));
  const missingMonths = months.filter(
    (month) => !inPeriod.some((row) => row.month === month),
  );

  const byChannel = AD_CHANNELS.map((channel) => ({
    channel,
    rows: inPeriod.filter((row) => row.channel === channel),
  }))
    .filter((entry) => entry.rows.length > 0)
    .map((entry) => ({
      channel: entry.channel,
      amount: entry.rows.reduce((sum, row) => sum + row.amountCop, 0),
    }));

  if (inPeriod.length === 0) {
    return {
      ...base,
      state: "sin-inversion",
      spend: null,
      byChannel,
      missingMonths,
      costPerNew: null,
      recovered: null,
    };
  }

  const spend = inPeriod.reduce((sum, row) => sum + row.amountCop, 0);

  if (spend === 0) {
    return {
      ...base,
      state: "sin-pauta",
      spend,
      byChannel,
      missingMonths,
      costPerNew: null,
      recovered: null,
    };
  }

  return {
    ...base,
    state: newCustomers.length === 0 ? "sin-clientas" : "ok",
    spend,
    byChannel,
    missingMonths,
    // A peso entero: Colombia no tiene centavos, y un costo de "$ 23.333,33"
    // invita a creer en una precisión que la cifra de entrada no tiene.
    costPerNew: newCustomers.length === 0 ? null : Math.round(spend / newCustomers.length),
    recovered: revenueFromNew / spend,
  };
}

// ── El formulario de inversión ──────────────────────────────────────────────

export type AdSpendForm = {
  month: string;
  channel: AdChannel;
  amountCop: Cop;
  notes: string | null;
};

/**
 * Lo que llega del formulario → una fila válida, o el motivo en castellano.
 *
 * Vive acá y no en la Server Action para poder testear cada rechazo sin una
 * sesión ni una base. El monto llega como lo escribió la persona
 * (`"1.200.000"`, `"$ 1200000"`): se toman los dígitos, como en `MoneyInput`.
 */
export function parseAdSpendForm(raw: {
  month: unknown;
  channel: unknown;
  amount: unknown;
  notes: unknown;
}): { ok: true; value: AdSpendForm } | { ok: false; message: string } {
  const month = parseMonth(raw.month);
  if (month === null) return { ok: false, message: "Elige el mes de la inversión." };

  const channel = AD_CHANNELS.find((option) => option === raw.channel);
  if (channel === undefined) return { ok: false, message: "Elige el canal de la pauta." };

  const text = typeof raw.amount === "string" ? raw.amount.trim() : "";
  // Un signo menos o una coma decimal no son "dígitos de más": son otra cifra.
  // Se rechazan antes de pelar los dígitos, que convertiría "-200.000" en
  // 200.000 y "1.500,50" en ciento cincuenta mil cincuenta.
  if (/-|,\d{1,2}$/.test(text)) {
    return { ok: false, message: "La inversión va en pesos enteros, sin signo ni centavos." };
  }
  const digits = text.replace(/[^\d]/g, "");
  if (digits === "") return { ok: false, message: "Escribe cuánto se invirtió (puede ser 0)." };
  const amountCop = Number(digits);
  if (!Number.isSafeInteger(amountCop) || amountCop > AD_SPEND_MAX) {
    return { ok: false, message: "Esa cifra es demasiado grande para un mes. Revisa los ceros." };
  }

  const notesText = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (notesText.length > 500) return { ok: false, message: "La nota es muy larga (máximo 500)." };

  return {
    ok: true,
    value: { month, channel, amountCop, notes: notesText === "" ? null : notesText },
  };
}
