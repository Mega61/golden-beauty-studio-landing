import { weekdayOf } from "./booking";

/**
 * Las promos en `/reservar`, la mitad pura.
 *
 * Quien decide es el panel (`admin/src/lib/promos.ts`, vía
 * `/api/reservas/cotizar`): es el que tiene los precios de EA y el historial de
 * la clienta. Acá solo se adelanta lo que ya se sabe con el catálogo —la promo
 * del día, que no depende de quién reserva— para que el precio cambie en el
 * mismo toque en que se elige el miércoles, sin esperar una ida y vuelta. En
 * cuanto llega la cotización del panel, manda la cotización.
 *
 * Mismas reglas que el panel: no se acumulan y gana el descuento mayor. Un combo
 * trae como promo del día lo que cuestan sus mitades con la promo puesta (lo
 * calcula el panel en el catálogo), así que acá es un renglón más.
 */

/** Una promo del día de un servicio, tal como la manda el catálogo. */
export type DayPromo = { slug: string; label: string; weekday: number; promoCOP: number };

/** Un renglón de la visita: el servicio, o cada mitad de un par. */
export type PromoLine = { priceCOP: number; dayPromos?: readonly DayPromo[] };

export type AppliedPromo = { slug: string; discount: number };

/**
 * La promo del día que le toca a la visita en `date`, o `null`.
 *
 * Igual que `dayQuote()` del panel: por cada promo de ese día de la semana se
 * suma lo que baja cada renglón, y gana la que más baja. Un precio de promo que
 * no queda por debajo del precio de lista no cuenta — un tachado que no ahorra
 * nada es publicidad falsa.
 */
export function dayPromoOn(lines: readonly PromoLine[], date: string): AppliedPromo | null {
  const weekday = weekdayOf(date);
  const bySlug = new Map<string, number>();
  for (const line of lines) {
    for (const promo of line.dayPromos ?? []) {
      if (promo.weekday !== weekday) continue;
      const saves = line.priceCOP - promo.promoCOP;
      if (saves > 0) bySlug.set(promo.slug, (bySlug.get(promo.slug) ?? 0) + saves);
    }
  }
  let best: AppliedPromo | null = null;
  for (const [slug, discount] of bySlug) {
    if (best === null || discount > best.discount) best = { slug, discount };
  }
  return best;
}

/**
 * Las pistas para la tarjeta del servicio en el paso 1 ("Miércoles $25.000"):
 * una por día de la semana, la más barata, en orden de semana empezando el
 * lunes, que es como la lee la clienta.
 */
export function promoHints(priceCOP: number, dayPromos: readonly DayPromo[] | undefined): DayPromo[] {
  const byDay = new Map<number, DayPromo>();
  for (const p of dayPromos ?? []) {
    if (p.promoCOP >= priceCOP) continue;
    const seen = byDay.get(p.weekday);
    if (!seen || p.promoCOP < seen.promoCOP) byDay.set(p.weekday, p);
  }
  return [...byDay.values()].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7));
}

/** Lo que responde el panel. */
export type ServerQuote = {
  subtotal: number;
  promo: { slug: string; discount: number } | null;
  total: number;
  /** `null` = no se sabe; la pantalla no promete el 10%. */
  firstVisit: boolean | null;
};

/**
 * Valida la respuesta de `/api/reservas/cotizar`. Algo que no tenga la forma
 * esperada se descarta entero (`null`) y la pantalla se queda con la promo del
 * día que ya calculó: mejor eso que pintar `NaN` en el botón de confirmar.
 */
export function parseQuote(body: unknown): ServerQuote | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const subtotal = num(b.subtotal);
  const total = num(b.total);
  if (subtotal === null || total === null || total > subtotal) return null;
  const firstVisit = b.firstVisit === true ? true : b.firstVisit === false ? false : null;
  let promo: ServerQuote["promo"] = null;
  if (b.promo !== null && b.promo !== undefined) {
    if (typeof b.promo !== "object") return null;
    const p = b.promo as Record<string, unknown>;
    const discount = num(p.discount);
    if (typeof p.slug !== "string" || discount === null || discount <= 0) return null;
    promo = { slug: p.slug, discount };
  }
  return { subtotal, promo, total, firstVisit };
}

/**
 * Qué se le muestra: la cotización del panel si es de esta misma visita, y si
 * no, la promo del día calculada acá. El total nunca baja de cero.
 */
export function visitPricing(
  listPriceCOP: number,
  dayPromo: AppliedPromo | null,
  quote: ServerQuote | null,
): { promo: AppliedPromo | null; total: number; firstVisit: boolean | null } {
  if (quote) {
    return {
      promo: quote.promo,
      total: quote.total,
      firstVisit: quote.firstVisit,
    };
  }
  const discount = dayPromo ? Math.min(dayPromo.discount, listPriceCOP) : 0;
  return {
    promo: dayPromo && discount > 0 ? { slug: dayPromo.slug, discount } : null,
    total: listPriceCOP - discount,
    firstVisit: null,
  };
}

/** Una promo de la semana para la banda del paso 1. */
export type WeeklyPromo = {
  slug: string;
  weekday: number;
  /** El precio de promo más bajo entre los servicios que toca ("desde $25.000"). */
  fromCOP: number;
  /** La categoría con más servicios en la promo: a donde lleva tocarla. */
  category: string;
};

/**
 * Las promos del día que existen en el catálogo, una por promo, en orden de
 * semana empezando el lunes. Para que la clienta las vea antes de elegir nada,
 * no solo cuando toca el servicio indicado. Solo cuentan los precios que de
 * verdad bajan, igual que en `promoHints`.
 */
export function weeklyPromos(
  groups: readonly (readonly [string, readonly PromoLine[]])[],
): WeeklyPromo[] {
  const bySlug = new Map<string, { weekday: number; fromCOP: number; perCategory: Map<string, number> }>();
  for (const [category, lines] of groups) {
    for (const line of lines) {
      for (const p of line.dayPromos ?? []) {
        if (p.promoCOP >= line.priceCOP) continue;
        const seen = bySlug.get(p.slug) ?? { weekday: p.weekday, fromCOP: p.promoCOP, perCategory: new Map() };
        seen.fromCOP = Math.min(seen.fromCOP, p.promoCOP);
        seen.perCategory.set(category, (seen.perCategory.get(category) ?? 0) + 1);
        bySlug.set(p.slug, seen);
      }
    }
  }
  return [...bySlug.entries()]
    .map(([slug, s]) => ({
      slug,
      weekday: s.weekday,
      fromCOP: s.fromCOP,
      category: [...s.perCategory.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7));
}
