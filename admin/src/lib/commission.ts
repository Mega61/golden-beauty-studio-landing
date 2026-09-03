/**
 * El motor de comisiones.
 *
 * Una regla es cuatro cosas —a quién aplica, sobre qué aplica, cuánto es, y
 * desde cuándo— y este archivo las resuelve **por renglón de la cuenta**, no
 * por cita. Un montaje con tres uñas de diseño puede pagar dos tasas distintas,
 * y una cita agendada como press-on que terminó en forrado paga por el forrado:
 *
 * > **La base es el renglón REALIZADO, no el servicio agendado.**
 *
 * El motor no sabe qué se agendó y esa ignorancia es deliberada — no recibe el
 * campo. La cuenta ya resolvió qué se hizo (§ Cuenta de servicio) y pasarle
 * ambas cosas sería darle la oportunidad de elegir mal.
 *
 * Tres decisiones que el archivo sostiene y que no son detalles de
 * implementación:
 *
 * 1. **Base = lo cobrado en ese renglón, con el descuento ya prorrateado.**
 *    Quien da el descuento también se baja su comisión, y el incentivo se
 *    alinea solo. El prorrateo lo hizo `lib/ticket.ts`; acá llega hecho, en
 *    `netTotal`. Recalcularlo sería la segunda implementación del mismo reparto,
 *    que es como se llega a dos liquidaciones distintas del mismo periodo.
 * 2. **Sin regla aplicable ⇒ cero MARCADO.** Nunca cero silencioso. Es la misma
 *    regla que `lib/price-snapshot.ts` y por la misma razón: un cero que nadie
 *    puede distinguir de un cero correcto es una liquidación mal pagada sin que
 *    nadie se entere.
 * 3. **Redondeo a pesos por renglón**, no al final de la quincena. Colombia no
 *    tiene centavos y el `commission_entry` se guarda por renglón; redondear
 *    después dejaría la suma de las filas distinta del total de la liquidación.
 *
 * **Las tasas reales todavía no existen** (§ Decisiones pendientes: faltan las
 * tasas por técnica y por categoría, si los adicionales pagan, y si hay
 * escalonado). Este archivo es el motor; las reglas entran como datos. No hay
 * ni una tasa por defecto acá adentro, a propósito: un default que parezca
 * plausible es el que termina liquidando una quincena real sin que nadie lo
 * haya aprobado.
 */

import type {
  BasisPoints,
  CommissionAppliesTo,
  CommissionRuleKind,
  Cop,
  FinanceItemKind,
} from "@/db/types";

import { FULL_BASIS_POINTS, allocateByWeights } from "./combo-allocation";

export class CommissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionError";
  }
}

/**
 * Una regla vigente, en forma de dominio.
 *
 * Espeja `commission_rule` en camelCase. `null` en provider / categoría /
 * servicio significa **todas**, y las fechas son de calendario (`YYYY-MM-DD`),
 * no instantes: una quincena es un corte de calendario y tratarla como instante
 * la corre cinco horas.
 */
export type CommissionRuleInput = {
  id: number;
  eaProviderId: number | null;
  /** Categoría de `pricing.ts`: montajes, retoques, forrados, sencillos, combos, extras. */
  categoryId: string | null;
  eaServiceId: number | null;
  appliesTo: CommissionAppliesTo;
  kind: CommissionRuleKind;
  percentBp: BasisPoints | null;
  fixedAmount: Cop | null;
  validFrom: string;
  /** **Inclusivo**: una regla que termina el 15 aplica al día 15 completo. */
  validTo: string | null;
};

/**
 * Un renglón listo para comisionar.
 *
 * `baseAmount` es el `netTotal` que devolvió `lib/ticket.ts` — lo cobrado en
 * ese renglón con el descuento del ticket ya prorrateado.
 */
export type CommissionableLine = {
  /** `appointment_finance_item.id`. Llave con la que se guarda el resultado. */
  itemId: number;
  kind: FinanceItemKind;
  eaServiceId: number | null;
  categoryId: string | null;
  baseAmount: Cop;
  /** Fecha de la cita, `YYYY-MM-DD`. Es contra ésta que se evalúa la vigencia. */
  serviceDate: string;
};

/**
 * Quién trabajó el renglón, y en qué proporción.
 *
 * Casi siempre es una sola técnica al 100 %. La lista existe por el combo
 * trabajado por dos personas, que se resuelve con `allocation_hands_bp` más un
 * provider secundario en `appointment_finance` — **no partiendo la cita**, que
 * duplicaría el evento de Google y la notificación a la clienta.
 */
export type LineAssignment = {
  eaProviderId: number;
  /** Puntos básicos del renglón que le tocan. La lista tiene que sumar 10000. */
  shareBp: BasisPoints;
};

/** Por qué este resultado necesita ojos humanos antes de pagarse. */
export type CommissionFlag =
  /** Ninguna regla vigente aplica al renglón. Cero marcado, no cero calculado. */
  | "sin-regla"
  /**
   * Renglón fuera del catálogo. No tiene servicio ni categoría, así que ninguna
   * regla por servicio o por categoría puede alcanzarlo, y `applies_to` no
   * tiene un valor que lo describa. Se deja en cero y se marca en vez de
   * meterlo a la fuerza en el balde de `principal`.
   */
  | "renglon-manual"
  /**
   * Dos reglas empatan en especificidad **y** en `valid_from`. El editor de
   * D1 no deja guardar eso, pero el motor no puede confiar en el editor: los
   * datos también entran por migración y por SQL. Se resuelve de forma
   * determinista (gana el `id` mayor, la última creada) y se marca — elegir en
   * silencio sería adivinar.
   */
  | "regla-ambigua";

export type CommissionResult = {
  itemId: number;
  eaProviderId: number;
  /** `null` ⇔ no se aplicó ninguna regla. Se guarda así en `commission_entry`. */
  ruleId: number | null;
  /** La parte de la base que le tocó a esta técnica. */
  baseAmount: Cop;
  /** Tasa congelada, si la regla era `percent`. */
  rateBp: BasisPoints | null;
  amount: Cop;
  /** `true` ⇔ `flag !== null`. */
  flagged: boolean;
  flag: CommissionFlag | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): void {
  if (!DATE_RE.test(value)) {
    throw new CommissionError(`${what} tiene que ser YYYY-MM-DD, y llegó ${JSON.stringify(value)}`);
  }
}

function assertPesos(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new CommissionError(`${what} tiene que ser un entero de pesos, y llegó ${value}`);
  }
}

/**
 * Redondeo a pesos, **simétrico**: medio peso se aleja del cero en los dos
 * sentidos.
 *
 * El modo de redondeo es una decisión de negocio, no un detalle. `Math.round()`
 * suelto redondea `-0.5` hacia `0` y `0.5` hacia `1`, así que una comisión de
 * −1.234,5 y una de +1.234,5 se irían para lados distintos y una corrección no
 * cancelaría exactamente el cobro que corrige. Con el signo afuera, sí.
 *
 * No se usa "medio par" (banker's rounding): reparte mejor el sesgo en
 * agregados grandes, pero acá cada renglón se le muestra a una persona, y que
 * 12,5 % de 5.000 dé 625 en un renglón y 624 en el siguiente es imposible de
 * explicar en una liquidación.
 */
export function roundPesos(value: number): Cop {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));

  // `-0` es igual a `0` con `===` pero distinto con `Object.is`, que es lo que
  // usan los tests y varios `Map`. Normalizarlo acá evita que un cero negativo
  // se filtre a una fila de `commission_entry` y a un reporte.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Qué tan específica es una regla. Más alto gana.
 *
 * ```text
 * provider + service ▶ provider + category ▶ provider ▶ service ▶ category ▶ global
 * ```
 *
 * Un servicio implica su categoría, así que una regla con provider, servicio
 * **y** categoría no es más específica que una con provider y servicio: la
 * categoría es redundante. Sigue teniendo que coincidir para que la regla
 * aplique — simplemente no suma especificidad.
 */
export function ruleSpecificity(rule: CommissionRuleInput): number {
  if (rule.eaProviderId !== null && rule.eaServiceId !== null) return 5;
  if (rule.eaProviderId !== null && rule.categoryId !== null) return 4;
  if (rule.eaProviderId !== null) return 3;
  if (rule.eaServiceId !== null) return 2;
  if (rule.categoryId !== null) return 1;
  return 0;
}

/**
 * A qué balde de `applies_to` pertenece un renglón.
 *
 * `manual` no tiene balde y devuelve `null` — ver el flag `renglon-manual`.
 */
function bucketFor(kind: FinanceItemKind): CommissionAppliesTo | null {
  if (kind === "servicio") return "principal";
  if (kind === "adicional") return "adicionales";
  return null;
}

function matches(
  rule: CommissionRuleInput,
  line: CommissionableLine,
  eaProviderId: number,
  bucket: CommissionAppliesTo,
): boolean {
  if (rule.eaProviderId !== null && rule.eaProviderId !== eaProviderId) return false;
  if (rule.eaServiceId !== null && rule.eaServiceId !== line.eaServiceId) return false;
  if (rule.categoryId !== null && rule.categoryId !== line.categoryId) return false;
  if (rule.appliesTo !== "ambos" && rule.appliesTo !== bucket) return false;

  // Las fechas son `YYYY-MM-DD`, así que comparar las cadenas ordena igual que
  // comparar calendarios y no construye un `Date` que habría que anclar a una
  // zona. `valid_to` inclusivo: `<=`, no `<`.
  if (line.serviceDate < rule.validFrom) return false;
  if (rule.validTo !== null && line.serviceDate > rule.validTo) return false;

  return true;
}

export type RuleResolution = {
  rule: CommissionRuleInput | null;
  flag: CommissionFlag | null;
};

/**
 * La regla que gana para un renglón, o ninguna.
 *
 * Exportada aparte de `computeCommissions()` porque el **simulador** de D1
 * ("¿cuánto habría pagado la quincena pasada con estas reglas?") necesita poder
 * mostrar *cuál* regla ganó renglón por renglón, no solo el total. Un simulador
 * que solo muestra el número no aumenta la confianza en el motor.
 */
export function resolveRule(
  rules: readonly CommissionRuleInput[],
  line: CommissionableLine,
  eaProviderId: number,
): RuleResolution {
  const bucket = bucketFor(line.kind);

  if (bucket === null) {
    return { rule: null, flag: "renglon-manual" };
  }

  assertDate(line.serviceDate, "La fecha del servicio");

  const applicable = rules.filter((rule) => {
    assertDate(rule.validFrom, `La vigencia inicial de la regla ${rule.id}`);
    if (rule.validTo !== null) assertDate(rule.validTo, `La vigencia final de la regla ${rule.id}`);
    return matches(rule, line, eaProviderId, bucket);
  });

  if (applicable.length === 0) {
    return { rule: null, flag: "sin-regla" };
  }

  // Gana la más específica; a igual especificidad, la de `valid_from` más
  // reciente; y si ahí también empatan, la de `id` mayor — que es la última
  // creada. El tercer criterio no está en el plan porque el plan cuenta con que
  // el editor impida el empate; existe igual porque el motor tiene que dar el
  // mismo resultado dos veces aunque los datos entren por otro lado.
  const sorted = [...applicable].sort(
    (a, b) =>
      ruleSpecificity(b) - ruleSpecificity(a) ||
      (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0) ||
      b.id - a.id,
  );

  const winner = sorted[0];
  const runnerUp = sorted[1];

  const ambiguous =
    runnerUp !== undefined &&
    ruleSpecificity(runnerUp) === ruleSpecificity(winner) &&
    runnerUp.validFrom === winner.validFrom;

  return { rule: winner, flag: ambiguous ? "regla-ambigua" : null };
}

/**
 * Cuánto paga una regla sobre una base.
 *
 * **No se limita al valor de la base.** Una regla `fixed` de 50.000 sobre un
 * renglón de 10.000 devuelve 50.000, no 10.000: eso es una regla mal
 * configurada, y recortarla en silencio escondería el error justo donde más
 * caro sale. El simulador de D1 es el lugar donde eso se ve antes de pagarse.
 *
 * Un `fixed` paga **una vez por renglón**, no por unidad: la evaluación es por
 * renglón de la cuenta, y un renglón de tres diseños es un renglón. Queda
 * anotado como pendiente de confirmar con la dueña junto con las tasas.
 */
export function applyRule(rule: CommissionRuleInput, baseAmount: Cop): { amount: Cop; rateBp: BasisPoints | null } {
  assertPesos(baseAmount, "La base de comisión");

  if (rule.kind === "percent") {
    if (rule.percentBp === null || !Number.isSafeInteger(rule.percentBp)) {
      throw new CommissionError(
        `La regla ${rule.id} es de porcentaje y su percent_bp es ${rule.percentBp}`,
      );
    }

    return {
      amount: roundPesos((baseAmount * rule.percentBp) / FULL_BASIS_POINTS),
      rateBp: rule.percentBp,
    };
  }

  if (rule.fixedAmount === null || !Number.isSafeInteger(rule.fixedAmount)) {
    throw new CommissionError(
      `La regla ${rule.id} es de monto fijo y su fixed_amount es ${rule.fixedAmount}`,
    );
  }

  // **El fijo sigue el signo de la base.**
  //
  // El mecanismo de corrección del plan es un renglón nuevo que resta. Con un
  // porcentaje eso sale solo —base negativa, comisión negativa—, pero un monto
  // fijo devolvía su valor entero sin mirar el signo: un cobro de 50.000 y su
  // ajuste de −50.000 dejaban la quincena con base 0 y comisión **+10.000**.
  // Pagar dos veces por un trabajo que se anuló.
  //
  // Devolver cero tampoco alcanza —lo intenté— porque el cobro original ya pagó
  // sus 5.000 y la corrección tiene que **deshacerlos**, no abstenerse. Con el
  // signo espejado, cobro y ajuste suman exactamente cero, que es lo que una
  // corrección significa.
  //
  // Base exactamente cero sí paga cero: no hubo trabajo que remunerar.
  // Encontrado por `gbs-money-auditor` (H3).
  if (baseAmount === 0) {
    return { amount: 0, rateBp: null };
  }

  if (baseAmount < 0) {
    return { amount: -rule.fixedAmount, rateBp: null };
  }

  // Reparto del fijo entre quienes trabajaron el renglón — ver `shareOfFixed`
  // en el llamador. Acá se devuelve el fijo completo; partirlo es
  // responsabilidad de quien conoce las asignaciones.
  return { amount: rule.fixedAmount, rateBp: null };
}

/**
 * Reparte la base de un renglón entre quienes lo trabajaron.
 *
 * Con una sola técnica es la base entera. Con dos, el reparto usa el mismo
 * algoritmo de residuos que el combo, así que las partes suman exacto a la
 * base y ningún peso se pierde ni se duplica entre dos liquidaciones.
 */
function splitBase(baseAmount: Cop, assignments: readonly LineAssignment[]): Cop[] {
  if (assignments.length === 0) {
    throw new CommissionError("Un renglón sin técnica asignada no se puede comisionar");
  }

  const total = assignments.reduce((sum, a) => sum + a.shareBp, 0);

  if (total !== FULL_BASIS_POINTS) {
    throw new CommissionError(
      `El reparto del renglón suma ${total} bp y tiene que sumar ${FULL_BASIS_POINTS}`,
    );
  }

  return allocateByWeights(baseAmount, assignments.map((a) => a.shareBp));
}

/**
 * Reparte un monto **fijo** entre quienes trabajaron el renglón.
 *
 * Mismo algoritmo y mismos pesos que `splitBase`, a propósito: si la base se
 * parte 60/40, el fijo también, y las dos particiones cuentan la misma
 * historia en la liquidación. Suma exacta garantizada por `allocateByWeights`.
 */
function fixedShares(
  fixedAmount: Cop,
  assignments: readonly LineAssignment[],
): Cop[] {
  return allocateByWeights(fixedAmount, assignments.map((a) => a.shareBp));
}

/** Un renglón con quién lo trabajó. Es la unidad de entrada del motor. */
export type CommissionInput = {
  line: CommissionableLine;
  assignments: readonly LineAssignment[];
};

/**
 * El motor completo: renglones × reglas ⇒ una fila de `commission_entry` por
 * (renglón, técnica).
 *
 * Es una función pura sobre datos históricos, y eso es lo que hace posible el
 * simulador: correrla otra vez sobre la quincena pasada con reglas distintas no
 * toca nada.
 */
export function computeCommissions(
  inputs: readonly CommissionInput[],
  rules: readonly CommissionRuleInput[],
): CommissionResult[] {
  const results: CommissionResult[] = [];

  for (const { line, assignments } of inputs) {
    assertPesos(line.baseAmount, `La base del renglón ${line.itemId}`);

    const shares = splitBase(line.baseAmount, assignments);

    for (const [index, assignment] of assignments.entries()) {
      const baseAmount = shares[index];
      const { rule, flag } = resolveRule(rules, line, assignment.eaProviderId);

      if (rule === null) {
        results.push({
          itemId: line.itemId,
          eaProviderId: assignment.eaProviderId,
          ruleId: null,
          baseAmount,
          rateBp: null,
          amount: 0,
          flagged: true,
          flag,
        });
        continue;
      }

      const { amount, rateBp } = applyRule(rule, baseAmount);

      results.push({
        itemId: line.itemId,
        eaProviderId: assignment.eaProviderId,
        ruleId: rule.id,
        baseAmount,
        rateBp,
        // **Un fijo se reparte entre las asignaciones, no se paga por cada una.**
        //
        // "Un `fixed` paga una vez por renglón" tenía un solo eje cubierto —la
        // cantidad—, y el otro es el combo a cuatro manos que el plan describe
        // en § Combos: con dos técnicas, un fijo de 5.000 pagaba 5.000 **a cada
        // una**. `splitBase` se toma el trabajo de partir la base con reparto
        // exacto y `applyRule` la ignoraba por completo.
        //
        // Se reparte con el mismo `allocateByWeights` que la base, así que las
        // partes suman exacto al fijo y el peso de residuo no se pierde ni se
        // duplica. Con una sola asignación es el fijo entero, que es el caso de
        // todos los días. Encontrado por `gbs-money-auditor` (H2).
        amount:
          rule.kind === "fixed" && assignments.length > 1
            ? fixedShares(amount, assignments)[index]
            : amount,
        flagged: flag !== null,
        flag,
      });
    }
  }

  return results;
}

/** El total de una técnica en un conjunto de resultados. */
export type ProviderCommissionTotal = {
  eaProviderId: number;
  base: Cop;
  amount: Cop;
  /** Cuántos renglones quedaron marcados. Bloquea el paso a `revisada`. */
  flaggedCount: number;
};

/**
 * Suma por técnica, para la liquidación de la quincena.
 *
 * `flaggedCount` viaja con el total a propósito: la pantalla de liquidación
 * tiene que poder decir "este total ignora 4 renglones sin regla" en vez de
 * mostrar un número limpio que oculta el hueco.
 */
export function totalsByProvider(
  results: readonly CommissionResult[],
): ProviderCommissionTotal[] {
  const byProvider = new Map<number, ProviderCommissionTotal>();

  for (const result of results) {
    let total = byProvider.get(result.eaProviderId);

    if (total === undefined) {
      total = { eaProviderId: result.eaProviderId, base: 0, amount: 0, flaggedCount: 0 };
      byProvider.set(result.eaProviderId, total);
    }

    total.base += result.baseAmount;
    total.amount += result.amount;
    if (result.flagged) total.flaggedCount += 1;
  }

  return [...byProvider.values()].sort((a, b) => a.eaProviderId - b.eaProviderId);
}

/** Los dos cortes de la quincena, `YYYY-MM-DD` ambos inclusivos. */
export type CommissionPeriod = {
  periodStart: string;
  periodEnd: string;
};

/**
 * La quincena a la que cae una fecha: **1–15** y **16–fin de mes**.
 *
 * Los cortes están en el plan como "por confirmar que ésos son los cortes
 * reales" (§ El ciclo quincenal). Se implementan porque el motor necesita
 * *alguna* función de periodo para llenar `period_start`/`period_end`, y porque
 * cambiarlos después es cambiar esta función y nada más — no el modelo.
 */
export function fortnightFor(serviceDate: string): CommissionPeriod {
  assertDate(serviceDate, "La fecha");

  const year = Number(serviceDate.slice(0, 4));
  const month = Number(serviceDate.slice(5, 7));
  const day = Number(serviceDate.slice(8, 10));

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CommissionError(`Fecha fuera de rango: ${serviceDate}`);
  }

  const prefix = serviceDate.slice(0, 7);

  if (day <= 15) {
    return { periodStart: `${prefix}-01`, periodEnd: `${prefix}-15` };
  }

  // `Date.UTC(year, month, 0)` es el último día del mes anterior al índice
  // `month`, que con `month` 1-based es el último día de *este* mes. Se hace en
  // UTC para que la zona del proceso no corra el resultado un día.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    periodStart: `${prefix}-16`,
    periodEnd: `${prefix}-${String(lastDay).padStart(2, "0")}`,
  };
}
