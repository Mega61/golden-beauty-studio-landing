import type { EaLocalDate } from "@/lib/ea/datetime";
import { bestPromo, type PromoLineInput } from "@/lib/promos";

/**
 * La cotización de una reserva pública, en piezas puras.
 *
 * Todo lo que decide un número vive acá —qué renglones tiene la visita, qué
 * promo le toca, cuánto queda— y la ruta solo trae los datos y responde. El
 * navegador manda ids, nunca precios: los precios salen de EA (lo que se va a
 * cobrar) y el id de vitrina de cada servicio, de `service_map`.
 */

export type QuoteService = {
  id: number;
  price: number | null;
  isPrivate: boolean | null;
  duration: number | null;
};

export type QuoteRequest = {
  serviceId: number;
  /** La segunda mitad de un par sin combo (dos citas seguidas). */
  thenServiceId: number | null;
};

/**
 * Los renglones de la visita, o `null` si algún servicio no se puede reservar.
 *
 * Se mira lo mismo que mira el catálogo (no privado, con duración) para que
 * esta ruta no cotice algo que la reserva va a rechazar — y para que no sirva
 * de oráculo de los adicionales privados de EA.
 *
 * Un combo entra como **un** renglón con el id de vitrina del combo: no está
 * en `PROMO_RULES`, así que nunca recibe la promo del día (ya trae su propio
 * descuento) y sí cuenta para el 10% de primera visita.
 */
export function buildQuoteLines(
  request: QuoteRequest,
  services: readonly QuoteService[],
  slugOf: ReadonlyMap<number, string>,
): PromoLineInput[] | null {
  const ids = request.thenServiceId === null ? [request.serviceId] : [request.serviceId, request.thenServiceId];
  const lines: PromoLineInput[] = [];
  for (const id of ids) {
    const service = services.find((s) => s.id === id);
    if (!service || service.isPrivate || service.duration === null || service.duration <= 0) return null;
    lines.push({
      key: String(id),
      pricingId: slugOf.get(id) ?? null,
      // Un precio vacío en EA es "no se sabe", no "gratis": sin precio no hay
      // descuento que calcular, y el renglón suma cero.
      listPrice: service.price !== null && service.price > 0 ? service.price : 0,
      kind: "servicio",
    });
  }
  return lines;
}

export type Quote = {
  subtotal: number;
  promo: { slug: string; label: string; discount: number } | null;
  total: number;
  /**
   * `true` = no tiene ninguna visita atendida antes; `false` = ya vino;
   * `null` = no se sabe (sin teléfono, teléfono inválido, historial
   * incompleto o sin cupo para consultar). Con `null` **no** se promete el 10%.
   */
  firstVisit: boolean | null;
};

export function quoteVisit(lines: readonly PromoLineInput[], date: EaLocalDate, firstVisit: boolean | null): Quote {
  const subtotal = lines.reduce((sum, l) => sum + l.listPrice, 0);
  const promo = bestPromo({ lines, date, isFirstVisit: firstVisit === true });
  // El descuento nunca deja el total por debajo de cero, aunque EA tenga un
  // precio raro: un total negativo en pantalla es peor que no mostrar promo.
  const discount = promo === null ? 0 : Math.min(promo.discount, subtotal);
  return {
    subtotal,
    promo: promo === null || discount <= 0 ? null : { slug: promo.slug, label: promo.label, discount },
    total: subtotal - discount,
    firstVisit,
  };
}

/**
 * Cuándo se le pregunta a EA si un teléfono ya vino.
 *
 * Cada consulta cuesta varias llamadas a EA —una búsqueda de clientas por cada
 * forma en que se pudo guardar el número, más sus citas— y EA corta a 100 por
 * IP cada 120 s **para todo el panel**, agenda incluida. Además esta ruta se
 * puede alcanzar sin pasar por el proxy de la landing (el rewrite de `/admin`),
 * así que el límite por IP de allá no basta. Dos frenos, los dos en memoria:
 *
 * - **Recuerdo por teléfono** (`memoMs`): la misma clienta escribiendo y
 *   borrando su número no vuelve a costar nada. Que alguien pase de nueva a
 *   conocida en diez minutos no cambia nada que importe: el cierre de la
 *   cuenta vuelve a decidir con datos frescos.
 * - **Cupo global** (`maxLookups` por `windowMs`): pasado el cupo se responde
 *   "no se sabe" en vez de salir a EA. Lo peor de eso es que una clienta nueva
 *   no ve su 10% en la pantalla — y se le aplica igual al pagar.
 *
 * Que el cupo sea global y no por IP es a propósito: detrás del proxy todas
 * las peticiones llegan desde las IPs de Vercel, y una cabecera con la IP de la
 * clienta la puede inventar cualquiera que llame directo.
 */
export type LookupGate = {
  /** Lo que ya se sabe de este teléfono, o `undefined` si hay que preguntar. */
  remembered(phone: string): boolean | undefined;
  /** Reserva un cupo para consultar a EA. `false` = sin cupo, no preguntar. */
  take(): boolean;
  remember(phone: string, firstVisit: boolean): void;
};

export function createLookupGate(options: {
  maxLookups: number;
  windowMs: number;
  memoMs: number;
  maxEntries?: number;
  now?: () => number;
}): LookupGate {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const memo = new Map<string, { firstVisit: boolean; at: number }>();
  let taken: number[] = [];

  return {
    remembered(phone) {
      const hit = memo.get(phone);
      if (!hit) return undefined;
      if (now() - hit.at >= options.memoMs) {
        memo.delete(phone);
        return undefined;
      }
      return hit.firstVisit;
    },
    take() {
      const t = now();
      taken = taken.filter((at) => t - at < options.windowMs);
      if (taken.length >= options.maxLookups) return false;
      taken.push(t);
      return true;
    },
    remember(phone, firstVisit) {
      memo.delete(phone);
      // Un techo, para que un barrido de números no crezca la memoria sin
      // límite: se van primero los más viejos (el orden de inserción de Map).
      while (memo.size >= maxEntries) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
      memo.set(phone, { firstVisit, at: now() });
    },
  };
}
