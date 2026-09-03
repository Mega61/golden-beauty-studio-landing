import "server-only";

import { repositories, type Db } from "@/db";
import type {
  AppointmentFinance,
  AppointmentFinanceItem,
  AuthId,
  BasisPoints,
  CommissionEntry,
  CommissionRule,
  CommissionRunStatus,
  Cop,
  FinanceItemKind,
} from "@/db/types";
import {
  computeCommissions,
  fortnightFor,
  type CommissionFlag,
  type CommissionPeriod,
  type CommissionResult,
  type CommissionRuleInput,
  type CommissionableLine,
  type LineAssignment,
} from "@/lib/commission";
import { FULL_BASIS_POINTS } from "@/lib/combo-allocation";
import {
  computeTicketTotals,
  TicketError,
  type TicketItemInput,
} from "@/lib/ticket";
import {
  eaLocalToInstant,
  instantToEaDate,
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDate,
} from "@/lib/ea";

/**
 * La liquidación de una quincena: leer las cuentas cerradas, correr el motor y
 * congelar el resultado en `commission_entry`.
 *
 * ## Este archivo no hace aritmética de plata
 *
 * Ni una multiplicación. El reparto del descuento entre renglones lo hizo
 * `lib/ticket.ts` y se **reconstruye** con la misma función que lo calculó al
 * cerrar la cuenta; la tasa la aplica `lib/commission.ts`; el reparto entre dos
 * técnicas, `lib/combo-allocation.ts`. Lo único que este archivo suma son
 * enteros ya decididos, y lo hace en `sumEntries()`, que es pura y está
 * testeada. La razón es la de siempre: dos implementaciones del mismo reparto
 * son dos liquidaciones distintas del mismo periodo, y la segunda aparece meses
 * después sin que nadie sepa cuál está mal.
 *
 * ## La base es lo cobrado, y la propina no entra
 *
 * La tasa se aplica sobre `netTotal` —el total del renglón con el descuento del
 * ticket ya prorrateado—, no sobre el precio de lista. Quien da el descuento se
 * baja su comisión y el incentivo se alinea solo.
 *
 * La propina va aparte y **jamás** entra a la base. Ya es 100 % de la técnica y
 * se entrega el mismo día; sumarla a la base sería pagarle 40 % encima de plata
 * que ya era suya. `computeTicketTotals()` la mantiene fuera de `netTotal` por
 * construcción, así que acá se pasa tal como está guardada y el test lo fija.
 *
 * ## Nada se recalcula en retrospectiva
 *
 * `ea_appointments` no guarda plata: el precio se congela en
 * `appointment_finance` al cerrar la cuenta, y las reglas se leen **por la
 * fecha del servicio**, no por la de hoy (`listOverlappingPeriod()` trae todas
 * las que tocan el periodo y el motor elige por renglón). Una quincena vieja
 * liquidada con la tasa nueva es un número equivocado, no un número
 * actualizado.
 *
 * ## Correr dos veces no puede duplicar nada
 *
 * `commission_entry` tiene UNIQUE `(appointment_finance_item_id,
 * ea_provider_id)` y el repositorio hace upsert sobre esa llave, así que la
 * segunda corrida de la misma quincena reescribe las mismas filas en vez de
 * agregar una segunda tanda. `commission_run` tiene UNIQUE `(ea_provider_id,
 * period_start, period_end)` por lo mismo. Y una entrada `paid` no se reescribe
 * nunca: el repositorio la devuelve como `"paid"` y acá se cuenta aparte para
 * poder decirlo en voz alta.
 *
 * ## Lo agendado no es lo realizado
 *
 * El motor recibe los **renglones** de la cuenta, que son lo que la técnica
 * registró que hizo. El servicio agendado ni se le pasa. Una cita reservada
 * como press-on y cerrada como forrado paga forrado.
 */

export class CommissionRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionRunError";
  }
}

// ── El periodo ──────────────────────────────────────────────────────────────

/**
 * La quincena de una fecha: **1–15** y **16–fin de mes**, en calendario de
 * Bogotá.
 *
 * Es `fortnightFor()` de `lib/commission.ts` con el tipo de A1 en el borde. La
 * función vive allá porque el motor la necesita para llenar
 * `period_start`/`period_end`, y acá se reexporta para que la pantalla no tenga
 * que importar dos módulos para hablar de la misma quincena.
 */
export function fortnightOf(date: EaLocalDate | string): CommissionPeriod {
  return fortnightFor(date);
}

/** Un día antes o después, en calendario. Sin husos: es una fecha, no un instante. */
function shiftDay(date: string, days: number): EaLocalDate {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return parseEaLocalDate(at.toISOString().slice(0, 10));
}

/**
 * La quincena anterior o la siguiente.
 *
 * Se calcula saltando un día por fuera del corte y preguntando en qué quincena
 * cae, en vez de restar quince días: los periodos no son de igual duración
 * (febrero tiene una segunda quincena de trece días) y la aritmética de "menos
 * 15" se desalinea al segundo mes.
 */
export function shiftFortnight(
  period: CommissionPeriod,
  direction: -1 | 1,
): CommissionPeriod {
  return direction === -1
    ? fortnightOf(shiftDay(period.periodStart, -1))
    : fortnightOf(shiftDay(period.periodEnd, 1));
}

/**
 * Los instantes que delimitan la quincena: `[desde, hasta)`.
 *
 * El borde superior es **exclusivo** porque así son los rangos de instantes en
 * todo el panel (`listByStartRange`), mientras el periodo en sí es un rango de
 * calendario **inclusivo**. La conversión pasa por `eaLocalToInstant()`, que
 * ancla la medianoche en America/Bogota: con `new Date("2026-09-01")` el rango
 * empezaría a las 7 p. m. del 31 de agosto hora de Bogotá y la liquidación se
 * comería media jornada del periodo anterior.
 */
export function fortnightBounds(period: CommissionPeriod): [Date, Date] {
  const from = eaLocalToInstant(parseEaLocalDateTime(`${period.periodStart} 00:00:00`));
  const to = eaLocalToInstant(
    parseEaLocalDateTime(`${shiftDay(period.periodEnd, 1)} 00:00:00`),
  );
  return [from, to];
}

/** Los días de calendario de la quincena, en orden. */
export function fortnightDays(period: CommissionPeriod): EaLocalDate[] {
  const days: EaLocalDate[] = [];
  let day = parseEaLocalDate(period.periodStart);
  while (day <= period.periodEnd) {
    days.push(day);
    day = shiftDay(day, 1);
  }
  return days;
}

// ── Lo que la quincena es, como dato ────────────────────────────────────────

/** Un renglón de cuenta, reducido a lo que la comisión necesita. */
export type CommissionAccountItem = {
  itemId: number;
  kind: FinanceItemKind;
  eaServiceId: number | null;
  pricingId: string | null;
  qty: number;
  unitPriceSnapshot: Cop;
  /**
   * Como quedó guardado.
   *
   * Se compara contra `qty × unit_price_snapshot` recalculado en
   * `reconstructLines()`: si no coinciden, alguien escribió en la tabla por
   * fuera del flujo y la cuenta no se liquida.
   */
  lineTotal: Cop;
  note: string | null;
};

/**
 * Una cuenta cerrada, lista para comisionar.
 *
 * `serviceDate` es la fecha **de la cita** en calendario de Bogotá, no la del
 * cierre ni la del proceso. Es contra ésa que se evalúa la vigencia de las
 * reglas y en ésa cae la quincena: se cobra el mismo día, siempre, así que las
 * tres coinciden — pero la que manda está escrita.
 */
export type CommissionAccount = {
  financeId: number;
  eaAppointmentId: number;
  serviceDate: EaLocalDate | null;
  closed: boolean;
  eaProviderId: number | null;
  secondaryEaProviderId: number | null;
  performedServiceId: number | null;
  discount: Cop;
  amountCharged: Cop | null;
  tip: Cop;
  items: CommissionAccountItem[];
};

/** Fila de plata + sus renglones → la forma que el motor consume. */
export function toCommissionAccount(
  row: AppointmentFinance,
  items: readonly AppointmentFinanceItem[],
): CommissionAccount {
  return {
    financeId: row.id,
    eaAppointmentId: row.ea_appointment_id,
    // `null` = la fila no sabe cuándo fue la cita. Pasa con una cuenta creada a
    // mano o por un webhook con el cuerpo incompleto, y sin fecha no hay
    // quincena ni vigencia de regla: `planFortnight()` la salta y la marca.
    serviceDate:
      row.appointment_start_at === null ? null : instantToEaDate(row.appointment_start_at),
    closed: row.closed_at !== null,
    eaProviderId: row.ea_provider_id,
    secondaryEaProviderId: row.secondary_ea_provider_id,
    performedServiceId: row.performed_service_id,
    discount: row.discount,
    amountCharged: row.amount_charged,
    tip: row.tip,
    items: items.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      eaServiceId: item.ea_service_id,
      pricingId: item.pricing_id,
      qty: item.qty,
      unitPriceSnapshot: item.unit_price_snapshot,
      lineTotal: item.line_total,
      note: item.note,
    })),
  };
}

/** Fila de regla → la forma de dominio que `lib/commission.ts` resuelve. */
export function toCommissionRule(row: CommissionRule): CommissionRuleInput {
  return {
    id: row.id,
    eaProviderId: row.ea_provider_id,
    categoryId: row.category_id,
    eaServiceId: row.ea_service_id,
    appliesTo: row.applies_to,
    kind: row.kind,
    percentBp: row.percent_bp,
    fixedAmount: row.fixed_amount,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  };
}

// ── El plan ─────────────────────────────────────────────────────────────────

/**
 * Por qué una cuenta del periodo no produjo comisión.
 *
 * Ninguna de las siete es un caso raro que se pueda tragar en silencio: cada
 * una es plata cobrada que nadie va a cobrar de comisión, y la pantalla las
 * lista. Una cuenta saltada sin decirlo es exactamente igual a una comisión
 * perdida.
 */
export type SkipReason =
  /** La técnica todavía no cerró la cuenta. No hay qué comisionar. */
  | "sin-cerrar"
  /** La fila no dice cuándo fue la cita, así que no cae en ninguna quincena. */
  | "sin-fecha"
  /** Ninguna técnica asignada: no hay a quién pagarle. */
  | "sin-tecnica"
  /** Cuenta cerrada sin un solo renglón. No debería existir. */
  | "sin-renglones"
  /** Los renglones no reconstruyen el total guardado. Fila corrupta. */
  | "total-no-cuadra"
  /** `lib/ticket.ts` rechaza la cuenta: renglón manual sin nota, descuento mayor que el subtotal… */
  | "cuenta-ilegible"
  /** Dos técnicas y ninguna proporción que diga cómo repartir. */
  | "reparto-desconocido";

export type SkippedAccount = {
  financeId: number;
  eaAppointmentId: number;
  reason: SkipReason;
  /** Qué pasó, en la lengua de la pantalla. */
  message: string;
};

/**
 * Una fila de `commission_entry` por escribir, con la traza para la pantalla.
 *
 * Lleva `eaAppointmentId` y `serviceDate` además de lo que la tabla guarda
 * porque el desglose de la liquidación es por cita, no por renglón: "3.200 del
 * renglón 4109" no se puede revisar.
 */
export type PlannedEntry = {
  itemId: number;
  eaProviderId: number;
  ruleId: number | null;
  baseAmount: Cop;
  rateBp: BasisPoints | null;
  amount: Cop;
  flag: CommissionFlag | null;
  financeId: number;
  eaAppointmentId: number;
  serviceDate: EaLocalDate;
};

/** Cuánto le toca a una técnica en la quincena, según el plan. */
export type PlannedProviderTotal = {
  eaProviderId: number;
  base: Cop;
  amount: Cop;
  /** Renglones marcados. Bloquean la revisión de la quincena. */
  flagged: number;
  /** Citas distintas detrás del total. Es lo que la pantalla cuenta. */
  appointments: number;
};

export type CommissionPlan = {
  period: CommissionPeriod;
  entries: PlannedEntry[];
  skipped: SkippedAccount[];
  totals: PlannedProviderTotal[];
};

export type PlanFortnightInput = {
  period: CommissionPeriod;
  accounts: readonly CommissionAccount[];
  rules: readonly CommissionRuleInput[];
  /**
   * `ea_service_id` del combo → `allocation_hands_bp`.
   *
   * Solo hace falta cuando una cuenta tiene técnica secundaria. Sin la
   * proporción, un combo a cuatro manos no se reparte: se salta y se marca.
   */
  combos?: ReadonlyMap<number, BasisPoints>;
  /**
   * `ea_service_id` → categoría de `pricing.ts` (`montajes`, `sencillos`…).
   *
   * Hoy no hay ninguna regla por categoría —la tasa es una sola, global— así
   * que el resolvedor es opcional. Lo que **no** es opcional es que su ausencia
   * se note: si alguna regla del periodo tiene `category_id`, planear sin
   * resolvedor lanza en vez de dejar que la regla no coincida nunca y que todo
   * caiga silenciosamente en la global. Un 40 % donde debía ir un 15 % no se ve
   * en ninguna pantalla.
   */
  categoryOf?: (item: CommissionAccountItem) => string | null;
};

function skip(
  account: CommissionAccount,
  reason: SkipReason,
  message: string,
): SkippedAccount {
  return {
    financeId: account.financeId,
    eaAppointmentId: account.eaAppointmentId,
    reason,
    message,
  };
}

/**
 * Reconstruye los renglones con su parte del descuento, o dice por qué no pudo.
 *
 * **El prorrateo no se reimplementa acá**: se llama a `computeTicketTotals()`,
 * la misma función que lo calculó cuando la técnica cerró la cuenta, con los
 * mismos renglones en el mismo orden (`listByFinanceIds` ordena por `id`, y ese
 * orden es lo que hace determinista el peso de residuo). Así el `netTotal` que
 * comisiona es exactamente el que la clienta pagó por ese renglón.
 *
 * Las dos comparaciones de abajo son la única forma de notar una fila corrupta:
 * un `line_total` que no es `qty × unit_price`, o un `amount_charged` que no es
 * `Σ line_total − discount`. Cualquiera de las dos significa que alguien
 * escribió en la tabla por fuera del flujo, y liquidar sobre eso es pagar una
 * comisión sobre un número que nadie puede explicar.
 */
function reconstructLines(
  account: CommissionAccount,
): { ok: true; netTotals: Cop[] } | { ok: false; skipped: SkippedAccount } {
  const items: TicketItemInput[] = account.items.map((item) => ({
    kind: item.kind,
    eaServiceId: item.eaServiceId,
    pricingId: item.pricingId,
    qty: item.qty,
    unitPriceSnapshot: item.unitPriceSnapshot,
    note: item.note,
  }));

  let totals;
  try {
    totals = computeTicketTotals(items, account.discount, account.tip);
  } catch (error) {
    // **La rama del `throw` de abajo no tiene test y no se le puede escribir
    // uno.** `computeTicketTotals()` solo lanza `TicketError` para cualquier
    // dato que quepa en sus tipos: su única llamada externa es
    // `allocateByWeights()`, y llega ahí con pesos que suman al menos el
    // descuento, así que el `AllocationError` de "pesos en cero" es
    // inalcanzable. Se conserva porque las dos funciones son de otro paquete y
    // pueden cambiar, y porque tragar un error de programación como si fuera
    // una cuenta corrupta es cómo una liquidación entera se salta en silencio.
    if (error instanceof TicketError) {
      return {
        ok: false,
        skipped: skip(
          account,
          "cuenta-ilegible",
          `La cuenta no se puede reconstruir: ${error.message}`,
        ),
      };
    }
    throw error;
  }

  for (const [index, line] of totals.lines.entries()) {
    if (line.lineTotal !== account.items[index].lineTotal) {
      return {
        ok: false,
        skipped: skip(
          account,
          "total-no-cuadra",
          `El renglón ${account.items[index].itemId} está guardado en ` +
            `${account.items[index].lineTotal} y sus cantidades dan ${line.lineTotal}.`,
        ),
      };
    }
  }

  if (totals.amountCharged !== account.amountCharged) {
    return {
      ok: false,
      skipped: skip(
        account,
        "total-no-cuadra",
        `La cuenta cobró ${account.amountCharged} y sus renglones suman ` +
          `${totals.amountCharged}.`,
      ),
    };
  }

  return { ok: true, netTotals: totals.lines.map((line) => line.netTotal) };
}

/**
 * Quién trabajó el renglón, y en qué proporción.
 *
 * Casi siempre una sola técnica al 100 %. Con técnica secundaria —el combo a
 * cuatro manos del plan— el reparto sale de `allocation_hands_bp` de la fila
 * `combo`, que es criterio de la dueña y nunca una fórmula.
 *
 * **Solo el renglón del combo se reparte.** Los adicionales de esa misma cuenta
 * van completos a la técnica principal, y esto es una decisión que el plan no
 * fija: `appointment_finance` guarda **una** técnica secundaria para la cuenta
 * entera, no por renglón, así que no hay dato que diga quién hizo el diseño por
 * uña. Repartir los adicionales con la proporción del combo sería inventar ese
 * dato; dárselos a la principal es la lectura conservadora y explicable, y es
 * la que la pantalla muestra marcada como reparto. Queda pendiente de
 * confirmar con la dueña.
 *
 * Sin fila `combo` no se adivina: dos técnicas y ninguna proporción es
 * `reparto-desconocido`, la cuenta entera se salta y se marca. Partir 50/50 por
 * defecto sería pagarle a alguien la mitad de lo que trabajó sin que nadie lo
 * decidiera.
 */
function assignmentsFor(
  account: CommissionAccount,
  item: CommissionAccountItem,
  primaryEaProviderId: number,
  combos: ReadonlyMap<number, BasisPoints>,
): LineAssignment[] | null {
  const secondary = account.secondaryEaProviderId;

  if (secondary === null || secondary === primaryEaProviderId) {
    return [{ eaProviderId: primaryEaProviderId, shareBp: FULL_BASIS_POINTS }];
  }

  const handsBp =
    account.performedServiceId === null
      ? undefined
      : combos.get(account.performedServiceId);

  if (handsBp === undefined) return null;

  if (item.eaServiceId !== account.performedServiceId) {
    return [{ eaProviderId: primaryEaProviderId, shareBp: FULL_BASIS_POINTS }];
  }

  return [
    { eaProviderId: primaryEaProviderId, shareBp: handsBp },
    { eaProviderId: secondary, shareBp: FULL_BASIS_POINTS - handsBp },
  ];
}

/** ¿Alguna regla del periodo discrimina por categoría? */
function needsCategories(rules: readonly CommissionRuleInput[]): boolean {
  return rules.some((rule) => rule.categoryId !== null);
}

/**
 * La quincena, planeada: qué se va a escribir y qué no, sin tocar la base.
 *
 * Es pura a propósito. Es lo que hace posible el simulador del plan ("¿cuánto
 * habría pagado la quincena pasada con estas reglas?"): correrla otra vez con
 * otras reglas sobre las mismas cuentas no escribe nada.
 */
export function planFortnight(input: PlanFortnightInput): CommissionPlan {
  const { period, accounts, rules } = input;
  const combos = input.combos ?? new Map<number, BasisPoints>();

  if (input.categoryOf === undefined && needsCategories(rules)) {
    // Sin resolvedor, `line.categoryId` sería `null` y una regla por categoría
    // no coincidiría **nunca**: el renglón caería en la global y se pagaría la
    // tasa equivocada sin una sola marca. Lanzar es la única salida honesta.
    throw new CommissionRunError(
      "Hay reglas de comisión por categoría en el periodo y no se recibió cómo " +
        "resolver la categoría de cada renglón. Liquidar así pagaría la tasa global " +
        "donde debía aplicar la de la categoría.",
    );
  }

  const categoryOf = input.categoryOf ?? (() => null);

  const entries: PlannedEntry[] = [];
  const skipped: SkippedAccount[] = [];

  for (const account of accounts) {
    if (!account.closed) {
      skipped.push(
        skip(account, "sin-cerrar", "La cuenta de esta cita todavía no se cerró."),
      );
      continue;
    }

    if (account.serviceDate === null) {
      skipped.push(
        skip(account, "sin-fecha", "La cuenta no tiene la fecha de la cita."),
      );
      continue;
    }

    const serviceDate = account.serviceDate;

    if (serviceDate < period.periodStart || serviceDate > period.periodEnd) {
      // Defensa contra un llamador que traiga filas de otro rango. Escribirlas
      // con el `period_start`/`period_end` de esta quincena las metería en una
      // liquidación a la que no pertenecen, y la de su propia quincena las
      // volvería a contar.
      skipped.push(
        skip(
          account,
          "sin-fecha",
          `La cita del ${serviceDate} no cae en la quincena ${period.periodStart} – ${period.periodEnd}.`,
        ),
      );
      continue;
    }

    const primary = account.eaProviderId;
    if (primary === null) {
      skipped.push(
        skip(account, "sin-tecnica", "La cita no tiene técnica asignada."),
      );
      continue;
    }

    if (account.items.length === 0) {
      skipped.push(
        skip(account, "sin-renglones", "La cuenta se cerró sin un solo renglón."),
      );
      continue;
    }

    const reconstructed = reconstructLines(account);
    if (!reconstructed.ok) {
      skipped.push(reconstructed.skipped);
      continue;
    }

    const inputs: { line: CommissionableLine; assignments: LineAssignment[] }[] = [];
    let splitUnknown = false;

    for (const [index, item] of account.items.entries()) {
      const assignments = assignmentsFor(account, item, primary, combos);
      if (assignments === null) {
        splitUnknown = true;
        break;
      }
      inputs.push({
        line: {
          itemId: item.itemId,
          kind: item.kind,
          eaServiceId: item.eaServiceId,
          categoryId: categoryOf(item),
          baseAmount: reconstructed.netTotals[index],
          serviceDate,
        },
        assignments,
      });
    }

    if (splitUnknown) {
      skipped.push(
        skip(
          account,
          "reparto-desconocido",
          "Dos técnicas trabajaron esta cita y no hay un combo que diga en qué " +
            "proporción se reparte.",
        ),
      );
      continue;
    }

    for (const result of computeCommissions(inputs, rules)) {
      entries.push(toPlannedEntry(result, account, serviceDate));
    }
  }

  return { period, entries, skipped, totals: summarizePlan(entries) };
}

function toPlannedEntry(
  result: CommissionResult,
  account: CommissionAccount,
  serviceDate: EaLocalDate,
): PlannedEntry {
  return {
    itemId: result.itemId,
    eaProviderId: result.eaProviderId,
    ruleId: result.ruleId,
    baseAmount: result.baseAmount,
    rateBp: result.rateBp,
    amount: result.amount,
    flag: result.flag,
    financeId: account.financeId,
    eaAppointmentId: account.eaAppointmentId,
    serviceDate,
  };
}

/**
 * Los totales por técnica del plan.
 *
 * `flagged` viaja con el total a propósito: la pantalla tiene que poder decir
 * "este total deja 4 renglones sin regla" en vez de mostrar una cifra limpia
 * que esconde el hueco. Es la misma disciplina de `totalsByProvider()` en
 * `lib/commission.ts`, que no se usa acá solo porque no cuenta citas.
 */
export function summarizePlan(
  entries: readonly PlannedEntry[],
): PlannedProviderTotal[] {
  const byProvider = new Map<number, PlannedProviderTotal>();
  const seen = new Map<number, Set<number>>();

  for (const entry of entries) {
    let total = byProvider.get(entry.eaProviderId);
    if (total === undefined) {
      total = {
        eaProviderId: entry.eaProviderId,
        base: 0,
        amount: 0,
        flagged: 0,
        appointments: 0,
      };
      byProvider.set(entry.eaProviderId, total);
      seen.set(entry.eaProviderId, new Set());
    }

    total.base += entry.baseAmount;
    total.amount += entry.amount;
    if (entry.flag !== null) total.flagged += 1;
    seen.get(entry.eaProviderId)!.add(entry.eaAppointmentId);
  }

  for (const [eaProviderId, appointments] of seen) {
    byProvider.get(eaProviderId)!.appointments = appointments.size;
  }

  return [...byProvider.values()].sort((a, b) => a.eaProviderId - b.eaProviderId);
}

/**
 * Lo que hay que pagar según lo **guardado**, no según el plan.
 *
 * El total de la liquidación se calcula sobre las filas que quedaron en
 * `commission_entry`, y no sobre las que el plan acaba de producir. La
 * diferencia importa: una entrada ya pagada no se reescribe, así que el plan y
 * la base pueden discrepar, y lo que se le paga a alguien tiene que ser la suma
 * de lo que está escrito.
 */
export function sumEntries(entries: readonly CommissionEntry[]): Cop {
  let total = 0;
  for (const entry of entries) total += entry.amount;
  return total;
}

/** La llave de `uq_ce_item_provider`, como texto, para comparar en memoria. */
function entryKey(itemId: number, eaProviderId: number): string {
  return `${itemId}:${eaProviderId}`;
}

// ── La corrida ──────────────────────────────────────────────────────────────

export type CommissionRunDeps = { db: Db };

export type FortnightRunRow = {
  eaProviderId: number;
  runId: number;
  total: Cop;
  status: CommissionRunStatus;
  /** `true` = esta corrida creó la liquidación. */
  created: boolean;
  /**
   * `true` = el total se reescribió.
   *
   * `false` con `created: false` significa que la liquidación ya estaba
   * `revisada` o `pagada` y esta corrida no la tocó. No es un fallo: es la
   * inmutabilidad funcionando, y la pantalla lo dice.
   */
  recalculated: boolean;
};

export type FortnightWriteCounts = {
  inserted: number;
  updated: number;
  /**
   * Entradas que la corrida **no tocó porque ya estaban pagadas**, o porque la
   * quincena de esa técnica ya se pagó.
   *
   * Las dos son la misma cosa desde afuera —plata que salió y no se reescribe—
   * y por eso van en el mismo contador. Que sea distinto de cero no es un
   * error: es la inmutabilidad funcionando, y la pantalla lo dice en vez de
   * dejar creer que el recálculo alcanzó a todo.
   */
  frozen: number;
  /**
   * Entradas en borrador que se borraron porque su cuenta dejó de liquidar.
   *
   * Pasa cuando una cuenta se corrompe o se reabre entre dos corridas. Dejar la
   * entrada vieja sumando sería pagar por una cuenta que ya nadie puede
   * explicar; borrar una entrada **pendiente** no borra historia, porque no se
   * pagó nada todavía y la cuenta aparece en `skipped` con su motivo. Una
   * entrada `paid` no se borra nunca.
   */
  dropped: number;
};

export type FortnightRunResult = {
  period: CommissionPeriod;
  written: FortnightWriteCounts;
  /** Entradas marcadas: sin regla, renglón manual o regla ambigua. */
  flagged: number;
  skipped: SkippedAccount[];
  runs: FortnightRunRow[];
};

export type RunFortnightInput = {
  period: CommissionPeriod;
  actorUserId: AuthId;
  now?: Date;
  /** `ea_service_id` → categoría de `pricing.ts`. Ver `PlanFortnightInput`. */
  categoryOf?: (item: CommissionAccountItem) => string | null;
};

/**
 * Liquida la quincena: lee, planea, escribe y deja la liquidación en borrador.
 *
 * Correrla dos veces sobre la misma quincena tiene que dar el mismo resultado y
 * no una segunda tanda de entradas. Lo garantizan las dos UNIQUE del esquema; y
 * lo que garantiza que no se toque plata ya pagada es que el repositorio se
 * niegue, no que esta función se acuerde de preguntar.
 */
export async function runFortnight(
  deps: CommissionRunDeps,
  input: RunFortnightInput,
): Promise<FortnightRunResult> {
  const now = input.now ?? new Date();
  const { period } = input;
  const repos = repositories(deps.db);
  const [from, to] = fortnightBounds(period);

  const [financeRows, ruleRows, comboRows] = await Promise.all([
    repos.appointmentFinance.listByStartRange(from, to),
    repos.commissionRules.listOverlappingPeriod(period.periodStart, period.periodEnd),
    repos.combos.listAll(),
  ]);

  const itemRows = await repos.appointmentFinanceItems.listByFinanceIds(
    financeRows.map((row) => row.id),
  );

  const itemsByFinance = new Map<number, AppointmentFinanceItem[]>();
  for (const item of itemRows) {
    const list = itemsByFinance.get(item.appointment_finance_id);
    if (list === undefined) {
      itemsByFinance.set(item.appointment_finance_id, [item]);
    } else {
      list.push(item);
    }
  }

  const plan = planFortnight({
    period,
    accounts: financeRows.map((row) =>
      toCommissionAccount(row, itemsByFinance.get(row.id) ?? []),
    ),
    rules: ruleRows.map(toCommissionRule),
    combos: new Map(comboRows.map((combo) => [combo.ea_service_id, combo.allocation_hands_bp])),
    categoryOf: input.categoryOf,
  });

  const written: FortnightWriteCounts = { inserted: 0, updated: 0, frozen: 0, dropped: 0 };
  const plannedKeys = new Set(
    plan.entries.map((entry) => entryKey(entry.itemId, entry.eaProviderId)),
  );

  const runs = await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);

    // Las liquidaciones que ya existen se leen **antes** de escribir nada: una
    // quincena pagada es de solo lectura entera, no renglón por renglón. Sin
    // esto, una corrección posterior al pago escribiría una entrada nueva que
    // ninguna liquidación puede recoger — plata calculada que nadie va a pagar
    // y que ninguna pantalla podría explicar.
    const existing = await tx.commissionRuns.listByPeriod(
      period.periodStart,
      period.periodEnd,
    );
    const paidProviders = new Set(
      existing.filter((run) => run.status === "pagada").map((run) => run.ea_provider_id),
    );

    for (const entry of plan.entries) {
      if (paidProviders.has(entry.eaProviderId)) {
        written.frozen += 1;
        continue;
      }

      const outcome = await tx.commissionEntries.upsert({
        appointment_finance_item_id: entry.itemId,
        ea_provider_id: entry.eaProviderId,
        commission_rule_id: entry.ruleId,
        base_amount: entry.baseAmount,
        rate_bp: entry.rateBp,
        amount: entry.amount,
        period_start: period.periodStart,
        period_end: period.periodEnd,
      });

      if (outcome === "inserted") written.inserted += 1;
      else if (outcome === "updated") written.updated += 1;
      // `"paid"` es redundante con el `continue` de arriba —una entrada llega a
      // `paid` solo por `markPaidByRun()`, que corre en la misma transacción
      // que deja la liquidación en `pagada`— y por eso esta rama no tiene test.
      // Se conserva porque **el repositorio es la autoridad sobre una entrada
      // pagada**, no este archivo: si algún día una entrada quedara pagada sin
      // su liquidación, la queremos contada como congelada y no reescrita.
      else written.frozen += 1;
    }

    // La unión de las técnicas que el plan produjo con las que ya tienen
    // liquidación en el periodo. Una técnica cuyas cuentas se saltaron todas
    // sigue necesitando que su borrador vuelva a cero: dejarle el total viejo
    // sería pagarle por una cuenta que dejó de cuadrar.
    const providerIds = [
      ...new Set([
        ...plan.totals.map((total) => total.eaProviderId),
        ...existing.map((run) => run.ea_provider_id),
      ]),
    ].sort((a, b) => a - b);

    const rows: FortnightRunRow[] = [];

    for (const eaProviderId of providerIds) {
      const run = existing.find((candidate) => candidate.ea_provider_id === eaProviderId);

      if (run !== undefined && run.status !== "borrador") {
        // Revisada o pagada: el total que se revisó es el que se paga. No se
        // reescribe ni se re-engancha nada — el repositorio lo rechazaría, y
        // preguntar antes deja el mensaje en la pantalla en vez de en un stack.
        rows.push({
          eaProviderId,
          runId: run.id,
          total: run.total,
          status: run.status,
          created: false,
          recalculated: false,
        });
        continue;
      }

      const stored = await tx.commissionEntries.listByProviderAndPeriod(
        eaProviderId,
        period.periodStart,
        period.periodEnd,
      );
      const stale = stored.filter(
        (entry) =>
          entry.status === "pending" &&
          !plannedKeys.has(
            entryKey(entry.appointment_finance_item_id, entry.ea_provider_id),
          ),
      );

      if (stale.length > 0) {
        await tx.commissionEntries.deletePending(stale.map((entry) => entry.id));
        written.dropped += stale.length;
      }

      const staleIds = new Set(stale.map((entry) => entry.id));
      const kept = stored.filter((entry) => !staleIds.has(entry.id));
      const total = sumEntries(kept);

      if (run === undefined) {
        const runId = await tx.commissionRuns.insert({
          ea_provider_id: eaProviderId,
          period_start: period.periodStart,
          period_end: period.periodEnd,
          total,
        });
        await tx.commissionEntries.attachToRun(
          kept.map((entry) => entry.id),
          runId,
        );
        rows.push({
          eaProviderId,
          runId,
          total,
          status: "borrador",
          created: true,
          recalculated: true,
        });
        continue;
      }

      await tx.commissionRuns.setDraftTotal(run.id, total);
      await tx.commissionEntries.attachToRun(
        kept.map((entry) => entry.id),
        run.id,
      );
      rows.push({
        eaProviderId,
        runId: run.id,
        total,
        status: "borrador",
        created: false,
        recalculated: true,
      });
    }

    await tx.auditLog.append({
      actorUserId: input.actorUserId,
      action: "commission.run",
      entity: "commission_run",
      entityId: `${period.periodStart}/${period.periodEnd}`,
      after: {
        entries: plan.entries.length,
        inserted: written.inserted,
        updated: written.updated,
        frozen: written.frozen,
        dropped: written.dropped,
        skipped: plan.skipped.length,
        providers: rows.map((row) => ({ ea_provider_id: row.eaProviderId, total: row.total })),
      },
      at: now,
    });

    return rows;
  });

  return {
    period,
    written,
    flagged: plan.entries.filter((entry) => entry.flag !== null).length,
    skipped: plan.skipped,
    runs,
  };
}

// ── La compuerta ────────────────────────────────────────────────────────────

export type FortnightAssessment = {
  period: CommissionPeriod;
  /** Días del periodo, ya pasados, sin cierre diario. */
  missingDayCloses: EaLocalDate[];
  /** Entradas del periodo sin regla aplicable: cero **marcado**. */
  flaggedEntries: number;
  /** `true` = la quincena todavía no terminó. */
  open: boolean;
};

/**
 * Un motivo por el que la quincena todavía no se puede revisar.
 *
 * Es un dato y no una frase a propósito: la fecha se escribe distinto en la
 * pantalla ("martes 15 de septiembre") que en un log, y armar la frase acá
 * obligaría a este módulo —que corre también en un cron, sin navegador— a
 * conocer el formato de fecha de la interfaz. La frase la pone
 * `(panel)/comisiones/blockers.ts`.
 */
export type FortnightBlocker =
  /** La quincena no ha terminado. */
  | { kind: "en-curso"; until: string }
  /** Días ya pasados del periodo sin cierre de caja. */
  | { kind: "sin-cierre"; days: readonly string[] }
  /** Renglones sin regla aplicable: ceros marcados. */
  | { kind: "sin-regla"; count: number };

/**
 * Por qué esta quincena todavía no se puede revisar.
 *
 * Es la compuerta del plan: "no se puede marcar como revisada mientras queden
 * cuentas sin cerrar o días sin cerrar en el periodo". **El bloqueo es la
 * funcionalidad** — es lo único que hace aceptable que pagar sea irreversible.
 *
 * De los dos bloqueos que el plan nombra acá solo se comprueba uno, y no es un
 * olvido: "cuentas sin cerrar" ya lo garantiza el cierre diario, que no deja
 * cerrar un día con una cita atendida sin cuenta. Si los quince días están
 * cerrados, no quedan cuentas sin cerrar; y preguntárselo otra vez exigiría
 * consultar los estados de cita a EA, que es justamente de lo que la
 * liquidación no debería depender.
 */
export function fortnightBlockers(
  assessment: FortnightAssessment,
): FortnightBlocker[] {
  const blockers: FortnightBlocker[] = [];

  if (assessment.open) {
    blockers.push({ kind: "en-curso", until: assessment.period.periodEnd });
  }

  if (assessment.missingDayCloses.length > 0) {
    blockers.push({ kind: "sin-cierre", days: assessment.missingDayCloses });
  }

  if (assessment.flaggedEntries > 0) {
    blockers.push({ kind: "sin-regla", count: assessment.flaggedEntries });
  }

  return blockers;
}

/** Lee de la base lo que la compuerta necesita. */
export async function assessFortnight(
  deps: CommissionRunDeps,
  input: { period: CommissionPeriod; now?: Date },
): Promise<FortnightAssessment> {
  const now = input.now ?? new Date();
  const today = instantToEaDate(now);
  const { period } = input;
  const repos = repositories(deps.db);

  const [closes, flagged] = await Promise.all([
    repos.dayCloses.listByDateRange(period.periodStart, period.periodEnd),
    repos.commissionEntries.listUnmatchedInPeriod(period.periodStart, period.periodEnd),
  ]);

  const closed = new Set(closes.map((row) => row.close_date));

  return {
    period,
    // Un día que todavía no llegó no puede tener cierre, y listarlo como
    // faltante convertiría la compuerta en ruido durante toda la quincena.
    missingDayCloses: fortnightDays(period).filter(
      (day) => day < today && !closed.has(day),
    ),
    flaggedEntries: flagged.length,
    open: period.periodEnd >= today,
  };
}

// ── Los dos estados que faltan ──────────────────────────────────────────────

export type StatusChangeResult =
  | { ok: true; runId: number; already: boolean }
  | {
      ok: false;
      reason: "sin-liquidacion" | "sin-revisar" | "compuerta" | "pagada";
      message: string;
      blockers?: FortnightBlocker[];
    };

/**
 * Marca la quincena de una técnica como **revisada**.
 *
 * Es el paso que hace aceptable que pagar sea irreversible, así que se cobra la
 * compuerta completa antes: quincena terminada, todos los días cerrados y
 * ningún renglón sin regla.
 */
export async function markFortnightReviewed(
  deps: CommissionRunDeps,
  input: {
    period: CommissionPeriod;
    eaProviderId: number;
    actorUserId: AuthId;
    now?: Date;
  },
): Promise<StatusChangeResult> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);

  const run = await repos.commissionRuns.findByProviderAndPeriod(
    input.eaProviderId,
    input.period.periodStart,
    input.period.periodEnd,
  );

  if (run === undefined) {
    return {
      ok: false,
      reason: "sin-liquidacion",
      message: "Esta quincena todavía no se ha liquidado. Calcúlala primero.",
    };
  }

  if (run.status === "pagada") {
    return {
      ok: false,
      reason: "pagada",
      message: "Esta quincena ya se pagó y no se modifica.",
    };
  }

  if (run.status === "revisada") {
    return { ok: true, runId: run.id, already: true };
  }

  const blockers = fortnightBlockers(await assessFortnight(deps, { period: input.period, now }));
  if (blockers.length > 0) {
    return {
      ok: false,
      reason: "compuerta",
      message: "La quincena no se puede marcar como revisada todavía.",
      blockers,
    };
  }

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    await tx.commissionRuns.setStatus(run.id, "revisada", {
      userId: input.actorUserId,
      at: now,
    });
    await tx.auditLog.append({
      actorUserId: input.actorUserId,
      action: "commission.review",
      entity: "commission_run",
      entityId: run.id,
      before: { status: run.status, total: run.total },
      after: { status: "revisada", total: run.total },
      at: now,
    });
  });

  return { ok: true, runId: run.id, already: false };
}

/**
 * Marca la quincena de una técnica como **pagada**, y con eso la congela.
 *
 * Después de esto no hay ajuste: así se trabaja hoy y el sistema lo respalda en
 * vez de pelearlo. Lo que lo hace aceptable es que la revisión previa sea real,
 * y por eso el paso anterior es obligatorio — pagar desde borrador saltaría
 * justamente la compuerta que protege este acto.
 *
 * Las entradas se marcan `paid` en la misma transacción que la liquidación. Si
 * quedaran fuera, un recálculo posterior las reescribiría: el repositorio
 * protege lo pagado mirando `status`, no mirando la liquidación.
 */
export async function markFortnightPaid(
  deps: CommissionRunDeps,
  input: {
    period: CommissionPeriod;
    eaProviderId: number;
    actorUserId: AuthId;
    now?: Date;
  },
): Promise<StatusChangeResult> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);

  const run = await repos.commissionRuns.findByProviderAndPeriod(
    input.eaProviderId,
    input.period.periodStart,
    input.period.periodEnd,
  );

  if (run === undefined) {
    return {
      ok: false,
      reason: "sin-liquidacion",
      message: "Esta quincena todavía no se ha liquidado. Calcúlala primero.",
    };
  }

  if (run.status === "pagada") {
    return { ok: true, runId: run.id, already: true };
  }

  if (run.status === "borrador") {
    return {
      ok: false,
      reason: "sin-revisar",
      message:
        "Falta revisar esta quincena. Pagar es irreversible, así que la revisión " +
        "no se puede saltar.",
    };
  }

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    await tx.commissionRuns.setStatus(run.id, "pagada", {
      userId: input.actorUserId,
      at: now,
    });
    await tx.commissionEntries.markPaidByRun(run.id);
    await tx.auditLog.append({
      actorUserId: input.actorUserId,
      action: "commission.pay",
      entity: "commission_run",
      entityId: run.id,
      before: { status: run.status, total: run.total },
      after: { status: "pagada", total: run.total },
      at: now,
    });
  });

  return { ok: true, runId: run.id, already: false };
}
