import { COMBO_COMPOSITION } from "@/data/combo-composition";
import { FIRST_VISIT_PERCENT, PROMO_RULES } from "@/data/promo-rules";
import type { EaLocalDate } from "@/lib/ea/datetime";

/**
 * **Qué promo le toca a una visita.** Una sola función, pura, que usan la
 * reserva pública (`/api/public/booking/cotizar`), el formulario de la agenda
 * y el cierre de la cuenta: tres pantallas que no pueden decir tres precios.
 *
 * Las reglas son de la dueña (2026-10-16):
 *
 * - **Promos del día** (`PROMO_RULES`, copiado de la landing): el servicio
 *   `regularId` hecho ese día de la semana cuesta `promoCOP`.
 * - **Primera visita**: `FIRST_VISIT_PERCENT` sobre los servicios — nunca
 *   sobre los adicionales — de quien no tiene ninguna visita atendida antes.
 * - **No se acumulan**: gana el descuento mayor. En un empate gana la promo
 *   del día, que es la que la clienta vio en el afiche.
 *
 * **Un combo en día de promo paga lo menor** entre su precio de combo y sus dos
 * mitades sueltas con la promo puesta (decisión de la dueña, 2026-10-24): un
 * sábado, press on + semi pies cuesta $80.000 + $55.000 si eso es menos que el
 * combo. No se suman los dos descuentos —el del combo y el del día—: la
 * diferencia contra el precio de combo es *la* promo del día de ese renglón, y
 * compite con el 10% como cualquier otra. Sin esto, tomar el combo un sábado
 * salía más caro que reservar las dos mitades por separado. Las mitades salen
 * de `COMBO_COMPOSITION` (horneado de `pricing.ts`). El 10% sí aplica sobre el
 * precio del combo, que es "en todos los servicios".
 *
 * El descuento rebaja también la comisión: la profesional cobra su porcentaje
 * sobre lo cobrado, no sobre la lista (decisión de la dueña). Eso ya lo hace
 * `commissionBasesOf()` con cualquier descuento; acá no hay nada que hacer.
 */

export type PromoLineInput = {
  /** Lo que identifique el renglón para quien llama (se devuelve tal cual). */
  key: string;
  /** El id de `pricing.ts` del servicio, vía `service_map`. `null` = sin vínculo. */
  pricingId: string | null;
  /** Precio de lista del renglón (unitario × cantidad), en pesos. */
  listPrice: number;
  kind: "servicio" | "adicional";
};

export type PromoKind = "dia" | "primera_visita";

export type PromoQuote = {
  kind: PromoKind;
  /** `sabado-press` | `miercoles-pies` | `primera-visita`. */
  slug: string;
  /** Texto corto para mostrar: "Miércoles de pies", "10% primera visita". */
  label: string;
  /** Pesos que se descuentan en total. Siempre > 0. */
  discount: number;
  /** Cuánto le toca a cada renglón (solo los que bajan). */
  perLine: { key: string; discount: number }[];
};

export type PromoInput = {
  lines: readonly PromoLineInput[];
  /** El día de la cita, no el de hoy: la promo es del día en que se hace. */
  date: EaLocalDate;
  /** `true` = sin ninguna visita atendida antes de esta (EA ∪ Agenda Pro). */
  isFirstVisit: boolean;
};

const LABELS: Record<string, string> = {
  "sabado-press": "Sábado de Press",
  "miercoles-pies": "Miércoles de pies",
  "primera-visita": `${FIRST_VISIT_PERCENT}% primera visita`,
};

/** 0 = domingo … 6 = sábado, del día calendario (sin zona: es una fecha). */
export function weekdayOf(date: EaLocalDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

type PromoRule = (typeof PROMO_RULES)[keyof typeof PROMO_RULES];

/**
 * Lo que cuesta un servicio el día de `rule`, o `null` si esa promo no lo toca.
 *
 * Un servicio suelto: su `promoCOP`. Un combo con al menos una mitad en la
 * promo: la mitad rebajada + la otra a precio de lista. Quien llama compara
 * contra el precio de lista del renglón y solo cuenta lo que de verdad baja.
 */
function promoPriceOf(pricingId: string, rule: PromoRule): number | null {
  const direct = rule.items.find((i) => i.regularId === pricingId);
  if (direct) return direct.promoCOP;

  const combo = COMBO_COMPOSITION.find((c) => c.pricingId === pricingId);
  if (!combo) return null;
  const hands = rule.items.find((i) => i.regularId === combo.hands);
  const feet = rule.items.find((i) => i.regularId === combo.feet);
  if (!hands && !feet) return null;
  return (hands?.promoCOP ?? combo.handsPriceCOP) + (feet?.promoCOP ?? combo.feetPriceCOP);
}

/** Las promos del día que existen para un servicio, para pintarlas antes de elegir fecha. */
export function dayPromosFor(pricingId: string | null): { slug: string; label: string; weekday: number; promoCOP: number }[] {
  if (pricingId === null) return [];
  const out: { slug: string; label: string; weekday: number; promoCOP: number }[] = [];
  for (const [slug, rule] of Object.entries(PROMO_RULES)) {
    const promoCOP = promoPriceOf(pricingId, rule);
    if (promoCOP !== null) {
      out.push({ slug, label: LABELS[slug] ?? slug, weekday: rule.weekday, promoCOP });
    }
  }
  return out;
}

function dayQuote(lines: readonly PromoLineInput[], weekday: number): PromoQuote | null {
  let best: PromoQuote | null = null;
  for (const [slug, rule] of Object.entries(PROMO_RULES)) {
    if (rule.weekday !== weekday) continue;
    const perLine: { key: string; discount: number }[] = [];
    for (const line of lines) {
      if (line.kind !== "servicio" || line.pricingId === null) continue;
      const promoCOP = promoPriceOf(line.pricingId, rule);
      if (promoCOP === null) continue;
      // Un precio de lista ya por debajo de la promo (p. ej. editado en EA, o un
      // combo que ya sale más barato que sus mitades rebajadas) no genera un
      // descuento negativo: simplemente no aplica.
      const discount = line.listPrice - promoCOP;
      if (discount > 0) perLine.push({ key: line.key, discount });
    }
    const discount = perLine.reduce((sum, l) => sum + l.discount, 0);
    if (discount > 0 && (best === null || discount > best.discount)) {
      best = { kind: "dia", slug, label: LABELS[slug] ?? slug, discount, perLine };
    }
  }
  return best;
}

/** Redondeo a la centena, como se cobra en el estudio ($5.500, no $5.537). */
function roundCOP(value: number): number {
  return Math.round(value / 100) * 100;
}

function firstVisitQuote(lines: readonly PromoLineInput[]): PromoQuote | null {
  const perLine = lines
    .filter((l) => l.kind === "servicio" && l.listPrice > 0)
    .map((l) => ({ key: l.key, discount: roundCOP((l.listPrice * FIRST_VISIT_PERCENT) / 100) }))
    .filter((l) => l.discount > 0);
  const discount = perLine.reduce((sum, l) => sum + l.discount, 0);
  if (discount <= 0) return null;
  return { kind: "primera_visita", slug: "primera-visita", label: LABELS["primera-visita"], discount, perLine };
}

/** La promo que le corresponde a esta visita, o `null` si no aplica ninguna. */
export function bestPromo(input: PromoInput): PromoQuote | null {
  const day = dayQuote(input.lines, weekdayOf(input.date));
  const first = input.isFirstVisit ? firstVisitQuote(input.lines) : null;
  if (day === null) return first;
  if (first === null) return day;
  return first.discount > day.discount ? first : day;
}
