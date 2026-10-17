/**
 * El borrador de la cuenta: lo que la técnica **eligió**, no lo que costó.
 *
 * Este es el único archivo que sabe traducir "forrado en acrílico y tres uñas
 * con diseño" a los renglones que `lib/ticket.ts` sabe valorar, y por eso
 * merece ser explícito sobre qué guarda y qué no:
 *
 * > **El borrador no guarda plata.** Guarda ids y cantidades. Los precios los
 * > pone el catálogo en el momento de valorar.
 *
 * No es purismo. Tiene tres consecuencias que el flujo necesita:
 *
 * 1. **El mismo borrador vale en el cliente y en el servidor.** La hoja lo usa
 *    para pintar el total en vivo; la Server Action lo vuelve a valorar con
 *    *su* catálogo antes de escribir. Ningún precio viaja por la red como
 *    autoridad, así que un navegador manipulado no puede fijar un cobro.
 * 2. **Un borrador que durmió en `localStorage` no envejece mal.** Si el wifi
 *    se cayó a las 3 y la cuenta se manda a las 5, se valora con el catálogo de
 *    las 5. Guardar los precios habría congelado un número que nadie eligió.
 * 3. **Es diminuto.** Cabe de sobra en `localStorage` aunque queden diez
 *    borradores abiertos.
 *
 * La única excepción deliberada es el renglón `manual`, que por definición no
 * está en el catálogo: ahí sí viaja el monto que la técnica escribió, junto con
 * la nota que `lib/ticket.ts` le exige.
 */

import {
  TicketError,
  computeTicketTotals,
  houseCourtesyTicket,
  validateHouseCourtesyClose,
  validateTicketClose,
  type TicketItemInput,
  type TicketPayment,
  type TicketTotals,
} from "@/lib/ticket";
import type { Cop, PaymentMethod, VarianceReasonCode } from "@/db/types";
import { isEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";
import { bestPromo, type PromoQuote } from "@/lib/promos";
import { findService, type TicketCatalog } from "./catalog";

/** Sube cuando la forma guardada deja de ser legible por el código nuevo. */
export const DRAFT_VERSION = 2;

/**
 * La versión anterior, que guardaba **un** método de pago por cuenta.
 *
 * Se lee todavía, y no por nostalgia: hay borradores con esa forma en el
 * `localStorage` de los celulares del equipo. Descartarlos al subir la versión
 * —que es lo que hacía el parser— le borraría a la técnica lo que dejó escrito
 * entre dos clientas. La conversión vive en `draft-store.ts`.
 */
export const DRAFT_VERSION_SINGLE_METHOD = 1;

/**
 * Lo que la técnica lleva escrito de una cuenta.
 *
 * Las cantidades de adicionales viven en un objeto y no en un arreglo porque la
 * interacción real es un contador por chip: `+` sobre "diseño por uña" tres
 * veces tiene que dar `3`, no tres renglones que después alguien suma.
 */
export type TicketDraft = {
  version: typeof DRAFT_VERSION;
  eaAppointmentId: number;
  /** `null` = todavía no se eligió ninguno (una cita de EA sin servicio). */
  performedServiceId: number | null;
  /**
   * Servicios hechos **además** del principal, cada uno a su precio de lista
   * de hoy: "vino por rubber en manos y se hizo también pies". Ids de EA, en el
   * orden en que se agregaron.
   *
   * Existe porque no todo par es un combo: el combo es un precio que fija la
   * dueña, y mientras un par no lo tenga la única forma honesta de cobrarlo es
   * cada mitad a su lista. Cuando el par **sí** es un combo, la hoja ofrece
   * cambiar a él, que es lo que corresponde. Cada uno es un renglón `servicio`
   * y comisiona igual que el principal (`bucketFor()` en `lib/commission.ts`).
   */
  additionalServices: readonly number[];
  /** `{ [eaServiceId]: cantidad }`. Sin la clave = cero, nunca se guarda un 0. */
  extras: Readonly<Record<string, number>>;
  /** El renglón fuera de catálogo. Uno por cuenta: más de uno no ha hecho falta. */
  manual: { note: string; amount: Cop } | null;
  /** Total escrito a mano. `null` = se acepta el calculado. */
  totalOverride: Cop | null;
  varianceReasonCode: VarianceReasonCode | null;
  varianceReason: string;
  /** **No viajan a las notas de la cita en EA.** Ver `actions.ts`. */
  notes: string;
  /**
   * Cómo se cobró. Vacío = todavía no se cobró.
   *
   * Con **un** pago el monto que se guarde acá no se lee: lo pone
   * `draftToPayments()` con todo lo cobrado, porque "efectivo" significa
   * "efectivo, todo". Solo cuando hay dos el monto es un dato que alguien
   * escribió y que hay que respetar.
   */
  payments: readonly TicketPayment[];
  tip: Cop;
  /**
   * **Cortesía de la casa**: la clienta no paga, la profesional cobra su
   * comisión sobre el precio de lista. Con esto prendido el total es cero, no
   * hay método de pago ni propina, y el motivo lo pone el servidor
   * (`cortesia`). Solo la dueña lo puede guardar.
   */
  houseCourtesy: boolean;
  /**
   * Aplicar la promo que le toque a la cuenta (`bestPromo()`). Prendido por
   * defecto en una cuenta nueva; la técnica la puede quitar —y volver a poner—
   * desde la hoja. **Es una elección, no un monto**: cuánto descuenta lo vuelve
   * a calcular el servidor con su catálogo.
   *
   * Un borrador sin el campo (de antes de esta versión) es **no**: lo que la
   * técnica vio y cobró entonces no traía promo, y aplicarla al reenviarlo
   * cambiaría en silencio una plata que ya se recibió.
   */
  applyPromo: boolean;
  /**
   * Es su primera visita: le toca el 10 % en los servicios. Llega puesto por el
   * historial cuando se pudo revisar, y la técnica lo puede cambiar — es la
   * salida cuando el historial no responde. Lo que se guarda dice si coincidía
   * con el historial (ver `hoy/actions.ts`).
   */
  firstVisit: boolean;
  /** Epoch ms de la última tecla. Sirve para ordenar y para depurar. */
  updatedAt: number;
};

/**
 * El precio congelado que la cita ya traía.
 *
 * Lo puso el webhook (o el reconcile) al agendar, y **manda sobre el precio de
 * hoy mientras el servicio realizado sea el agendado**: es el precio que regía
 * cuando la clienta reservó. En cuanto la técnica cambia el servicio deja de
 * describir nada, y el renglón se valora con la lista de hoy — que es el mismo
 * día en que se presta, así que no hay deriva.
 */
export type TicketPricing = {
  bookedServiceId: number | null;
  bookedSnapshot: Cop | null;
  /**
   * El día **de la cita**, que es el que decide la promo del día (un miércoles
   * de pies es de la cita del miércoles, se cierre cuando se cierre).
   * Ausente o `null` = sin promos: mejor no descontar que descontar sobre un
   * día que no se sabe.
   */
  promoDate?: EaLocalDate | null;
};

/** El día de una hora de pared de EA (`"2026-10-14 10:00:00"` → `"2026-10-14"`). */
export function promoDateOf(start: string | null | undefined): EaLocalDate | null {
  const day = (start ?? "").slice(0, 10);
  return isEaLocalDate(day) ? day : null;
}

export function emptyDraft(
  eaAppointmentId: number,
  bookedServiceId: number | null,
  now = Date.now(),
  /**
   * La cuenta arranca marcada como cortesía de la casa. Lo decide quien llama
   * —la clienta es cortesía por defecto **y** quien abre la hoja puede
   * otorgarla—; acá solo se respeta.
   */
  houseCourtesy = false,
  /**
   * La promo arranca puesta: es lo que la clienta vio en el afiche, y quitarla
   * es la excepción. `firstVisit` lo pone quien sabe del historial.
   */
  promo: { applyPromo?: boolean; firstVisit?: boolean } = {},
): TicketDraft {
  return {
    version: DRAFT_VERSION,
    eaAppointmentId,
    // Paso 1 del flujo: "viene con el servicio agendado ya elegido".
    performedServiceId: bookedServiceId,
    additionalServices: [],
    extras: {},
    manual: null,
    totalOverride: null,
    varianceReasonCode: null,
    varianceReason: "",
    notes: "",
    payments: [],
    tip: 0,
    houseCourtesy,
    applyPromo: promo.applyPromo ?? true,
    firstVisit: promo.firstVisit ?? false,
    updatedAt: now,
  };
}

/**
 * El borrador que corresponde a una cuenta **ya guardada**.
 *
 * Hasta el cierre diario la cuenta se puede corregir, y corregir significa
 * reabrir la hoja con lo que había: sin esto, "editar" abriría un formulario en
 * blanco y guardar sería en realidad borrar los renglones anteriores.
 *
 * El total escrito a mano se reconstruye desde el descuento guardado: si la
 * cuenta se cerró con descuento, el campo vuelve editable con la cifra que se
 * cobró, y el motivo que la acompañaba sigue ahí. Sin eso, reabrir una cuenta
 * con descuento y guardarla sin tocar nada le devolvería el precio de lista.
 */
export function draftFromFinance(
  eaAppointmentId: number,
  bookedServiceId: number | null,
  finance: {
    performedServiceId: number | null;
    discount: Cop;
    tip: Cop;
    amountCharged: Cop | null;
    payments: readonly TicketPayment[];
    serviceNotes: string;
    varianceReasonCode: VarianceReasonCode | null;
    varianceReason: string;
    /** Ausente = no es cortesía. */
    houseCourtesy?: boolean;
    items: readonly {
      kind: "servicio" | "adicional" | "manual";
      eaServiceId: number | null;
      qty: number;
      unitPrice: Cop;
      note: string | null;
    }[];
  },
  now = Date.now(),
): TicketDraft {
  const extras: Record<string, number> = {};
  let manual: TicketDraft["manual"] = null;
  const additionalServices: number[] = [];
  const performedServiceId = finance.performedServiceId ?? bookedServiceId;
  let mainSeen = false;

  for (const item of finance.items) {
    // El primer renglón `servicio` que es el realizado es el principal; los
    // demás son los que se agregaron. Sin esto, reabrir una cuenta con dos
    // servicios y guardarla sin tocar nada borraría el segundo.
    if (item.kind === "servicio" && item.eaServiceId !== null) {
      if (!mainSeen && item.eaServiceId === performedServiceId) mainSeen = true;
      else additionalServices.push(item.eaServiceId);
    }
    if (item.kind === "adicional" && item.eaServiceId !== null) {
      extras[String(item.eaServiceId)] = (extras[String(item.eaServiceId)] ?? 0) + item.qty;
    }
    // Un solo renglón manual por cuenta: es lo que la hoja sabe editar. Si
    // alguna vez hubiera dos (una corrección entrada por API), gana el primero
    // y el segundo se perdería al guardar — por eso la hoja no es el camino
    // para corregir después del cierre, y ahí sí se rechaza de frente.
    if (item.kind === "manual" && manual === null) {
      manual = { note: item.note ?? "", amount: item.unitPrice };
    }
  }

  // Una cortesía guarda su "descuento" del 100 % y el motivo `cortesia`, pero
  // no los escribió nadie: los puso el servidor al marcar la casilla. Volver a
  // abrirla con el total escrito en cero y el motivo elegido dejaría a quien la
  // desmarca con una cuenta en $0 que ya no es cortesía.
  const cortesia = finance.houseCourtesy === true;
  // Lo mismo con la promo: su descuento y su motivo los puso el servidor. Se
  // reabre con la promo prendida y sin total escrito, para que la hoja la
  // recalcule igual que al cerrarla. Una cuenta guardada **sin** promo se
  // reabre sin ella aunque hoy le tocara: prenderla sola cambiaría el cobro de
  // una cuenta que ya se cerró.
  const promo = !cortesia && finance.varianceReasonCode === "promo";

  return {
    version: DRAFT_VERSION,
    eaAppointmentId,
    performedServiceId,
    additionalServices,
    extras,
    manual,
    totalOverride: !cortesia && !promo && finance.discount > 0 ? finance.amountCharged : null,
    varianceReasonCode: cortesia || promo ? null : finance.varianceReasonCode,
    varianceReason: cortesia || promo ? "" : finance.varianceReason,
    notes: finance.serviceNotes,
    payments: finance.payments,
    tip: finance.tip,
    houseCourtesy: cortesia,
    applyPromo: promo,
    firstVisit: promo && finance.varianceReason.startsWith(FIRST_VISIT_SLUG),
    updatedAt: now,
  };
}

/**
 * Los pagos que se mandan al servidor, a partir del borrador y del total.
 *
 * **Con un solo método el monto no se le pide a nadie**: es todo lo cobrado, y
 * pedirlo sería una casilla más para equivocarse en el 95 % de las cuentas.
 * Con dos, cada monto es un dato escrito y se manda tal cual — el servidor
 * verifica que sumen, y si no suman rechaza.
 *
 * Que el monto del pago único se derive acá y no se guarde en el borrador es
 * también lo que deja migrar los borradores de la versión 1 sin conocer el
 * total: ese campo no se lee.
 */
export function draftToPayments(
  draft: TicketDraft,
  amountCharged: Cop,
): TicketPayment[] {
  if (draft.payments.length === 0) return [];

  if (draft.payments.length === 1) {
    return [{ method: draft.payments[0].method, amount: amountCharged }];
  }

  return draft.payments.map((payment) => ({ ...payment }));
}

/** ¿Hay algo escrito que se pueda perder? Decide si el panel se cierra al tocar afuera. */
export function isDirty(draft: TicketDraft, baseline: TicketDraft): boolean {
  return (
    draft.performedServiceId !== baseline.performedServiceId ||
    JSON.stringify(draft.additionalServices) !== JSON.stringify(baseline.additionalServices) ||
    JSON.stringify(draft.extras) !== JSON.stringify(baseline.extras) ||
    JSON.stringify(draft.manual) !== JSON.stringify(baseline.manual) ||
    draft.totalOverride !== baseline.totalOverride ||
    draft.varianceReasonCode !== baseline.varianceReasonCode ||
    draft.varianceReason !== baseline.varianceReason ||
    draft.notes !== baseline.notes ||
    JSON.stringify(draft.payments) !== JSON.stringify(baseline.payments) ||
    draft.tip !== baseline.tip ||
    draft.houseCourtesy !== baseline.houseCourtesy ||
    draft.applyPromo !== baseline.applyPromo ||
    draft.firstVisit !== baseline.firstVisit
  );
}

/**
 * Cambia la cantidad de un adicional. `0` o menos lo borra del objeto.
 *
 * Que el cero borre la clave, en vez de guardarse, es lo que hace que dos
 * borradores con el mismo contenido se serialicen igual — de eso depende
 * `isDirty()`, y de `isDirty()` depende que cerrar la hoja no pregunte por
 * cambios que nadie hizo.
 */
export function setExtraQty(
  draft: TicketDraft,
  eaServiceId: number,
  qty: number,
  now = Date.now(),
): TicketDraft {
  const key = String(eaServiceId);
  const next: Record<string, number> = { ...draft.extras };

  if (qty <= 0) delete next[key];
  else next[key] = Math.trunc(qty);

  return { ...draft, extras: next, updatedAt: now };
}

export function bumpExtra(
  draft: TicketDraft,
  eaServiceId: number,
  delta: number,
  now = Date.now(),
): TicketDraft {
  const current = draft.extras[String(eaServiceId)] ?? 0;
  return setExtraQty(draft, eaServiceId, current + delta, now);
}

/** Por qué un renglón no se pudo valorar limpio. Se muestra, no se esconde. */
export type PriceFlag = {
  label: string;
  message: string;
};

export type DraftPricing = {
  items: TicketItemInput[];
  /** Renglones cuyo precio de lista EA no tiene. Se ven en pantalla. */
  flags: PriceFlag[];
  /** `Σ line_total` antes del descuento. `null` si los renglones no son válidos. */
  subtotal: Cop | null;
  /** El resultado de B1. `null` si no se pudo calcular. */
  totals: TicketTotals | null;
  /** Qué impide guardar. Vacío = se puede guardar. */
  errors: string[];
  /** La promo que le toca a la cuenta, esté aplicada o no. `null` = ninguna. */
  availablePromo: PromoQuote | null;
  /** La promo aplicada: su descuento es exactamente el de la cuenta. */
  promo: PromoQuote | null;
  /** El motivo que se va a guardar: `promo` si la variación es la promo. */
  varianceReasonCode: VarianceReasonCode | null;
};

// ---------------------------------------------------------------------------
// Promos
// ---------------------------------------------------------------------------

/** El `slug` del 10 % de primera visita en `lib/promos.ts`. */
export const FIRST_VISIT_SLUG = "primera-visita";

/**
 * La promo que le corresponde a estos renglones, el día de la cita.
 *
 * Un renglón `manual` no entra: está fuera del catálogo y no tiene un id de
 * vitrina con el que emparejar una promo del día, y el 10 % de primera visita
 * es "en los servicios". Cada renglón va con su total (`qty × precio`), que es
 * el precio congelado cuando el servicio es el agendado — la promo rebaja lo
 * que de verdad se iba a cobrar, no la lista de hoy.
 */
export function promoForItems(
  items: readonly TicketItemInput[],
  pricing: TicketPricing,
  firstVisit: boolean,
): PromoQuote | null {
  const date = pricing.promoDate ?? null;
  if (date === null) return null;

  const lines = items.flatMap((item, index) =>
    item.kind === "manual"
      ? []
      : [
          {
            key: String(index),
            pricingId: item.pricingId ?? null,
            listPrice: item.qty * item.unitPriceSnapshot,
            kind: item.kind,
          },
        ],
  );

  return bestPromo({ lines, date, isFirstVisit: firstVisit });
}

/** El descuento de la cuenta y el motivo con que se guarda. */
export type ResolvedDiscount = {
  /**
   * `subtotal − lo cobrado`. **Puede ser negativo** solo cuando el total
   * escrito supera el subtotal, que es un error que cada llamador reporta con
   * sus palabras (`ticketFromEnteredTotal()` en el servidor).
   */
  discount: Cop;
  availablePromo: PromoQuote | null;
  promo: PromoQuote | null;
  varianceReasonCode: VarianceReasonCode | null;
  varianceReason: string;
};

/**
 * **Cuánto se descuenta y por qué.** La misma función en la hoja y en la
 * Server Action, como `draftToItems()`: lo que se ve y lo que se guarda no
 * pueden divergir.
 *
 * - **Sin total escrito**: el descuento es la promo, si está prendida y le toca
 *   alguna. El motivo es `promo` y no se le pide nada a la técnica: la
 *   variación ya está explicada.
 * - **Con total escrito**: manda la cifra, como siempre. Si coincide con el
 *   total con promo, es la promo (tocar el total y no cambiarlo no es una
 *   rebaja nueva). Si no, es una variación de la técnica y lleva **su** motivo
 *   — la compuerta de `validateTicketClose()` lo exige igual que antes. La
 *   promo no se suma por debajo de un total escrito: la cifra escrita es lo que
 *   se cobró, y dos descuentos encima de ella serían cobrar algo que nadie dijo.
 * - **Cortesía de la casa**: no hay promo. La cortesía ya es el 100 %.
 *
 * Las promos no se acumulan entre sí (gana la mayor, `bestPromo()`), y tampoco
 * con un descuento escrito a mano.
 *
 * `promo` nunca sale del borrador: un borrador manipulado que lo traiga como
 * motivo se trata como sin motivo, porque ese código solo lo puede poner este
 * cálculo.
 */
export function resolveDiscount(
  draft: TicketDraft,
  items: readonly TicketItemInput[],
  subtotal: Cop,
  pricing: TicketPricing,
): ResolvedDiscount {
  const availablePromo = draft.houseCourtesy
    ? null
    : promoForItems(items, pricing, draft.firstVisit);
  const wanted = draft.applyPromo ? availablePromo : null;

  const discount =
    draft.totalOverride === null ? (wanted?.discount ?? 0) : subtotal - draft.totalOverride;

  if (wanted !== null && discount === wanted.discount) {
    return {
      discount,
      availablePromo,
      promo: wanted,
      varianceReasonCode: "promo",
      varianceReason: wanted.slug,
    };
  }

  const ownCode = draft.varianceReasonCode === "promo" ? null : draft.varianceReasonCode;

  return {
    discount,
    availablePromo,
    promo: null,
    varianceReasonCode: ownCode,
    varianceReason: ownCode === null ? "" : draft.varianceReason,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof TicketError) return error.message;
  // Cualquier otra cosa es un bug nuestro, no un dato inválido. Se deja subir
  // en vez de disfrazarlo de mensaje de validación: un error de programación
  // que aparece en pantalla como "revisa estos campos" manda a la técnica a
  // buscar un problema que no está en la cuenta.
  throw error;
}

/**
 * El borrador convertido en los renglones que `lib/ticket.ts` sabe valorar.
 *
 * Orden fijo y no casual: **servicio realizado, los servicios agregados en el
 * orden en que se agregaron, adicionales en el orden del catálogo, manual al
 * final.** El prorrateo del descuento reparte el peso del
 * residuo de forma determinista, y "determinista" exige que la lista llegue
 * siempre igual — el repositorio de A2 documenta lo mismo del lado de la base.
 *
 * Un adicional que ya no está en el catálogo (se renombró en EA entre que se
 * armó el borrador y se envió) **no se inventa**: se descarta del renglón y se
 * reporta como marca. Valorarlo en cero lo dejaría cobrado como cortesía sin
 * que nadie lo haya decidido.
 */
export function draftToItems(
  draft: TicketDraft,
  catalog: TicketCatalog,
  pricing: TicketPricing,
): { items: TicketItemInput[]; flags: PriceFlag[] } {
  const items: TicketItemInput[] = [];
  const flags: PriceFlag[] = [];

  const performed = findService(catalog, draft.performedServiceId);

  if (performed !== null) {
    const usaCongelado =
      pricing.bookedSnapshot !== null &&
      pricing.bookedServiceId !== null &&
      performed.eaServiceId === pricing.bookedServiceId;

    const price = usaCongelado ? pricing.bookedSnapshot : performed.listPrice;

    if (price === null) {
      flags.push({
        label: performed.name,
        message: "EA no tiene precio para este servicio. Escribe el total a mano.",
      });
    }

    items.push({
      kind: "servicio",
      eaServiceId: performed.eaServiceId,
      pricingId: performed.pricingId,
      qty: 1,
      unitPriceSnapshot: price ?? 0,
    });
  }

  // Los servicios agregados van **a la lista de hoy**, nunca al congelado: el
  // congelado es el precio del servicio que se reservó, y éstos no se
  // reservaron. Un adicional colado acá (la lista de la hoja no los ofrece) no
  // se cobra como servicio: se marca.
  for (const id of draft.additionalServices) {
    const service = findService(catalog, id);

    if (service === null || service.isExtra) {
      flags.push({
        label: `Servicio #${id}`,
        message:
          service === null
            ? "Ya no está en el catálogo de EA. No se cobró; revisa la cuenta."
            : "Es un adicional, no un servicio. Agrégalo en Adicionales.",
      });
      continue;
    }

    if (service.listPrice === null) {
      flags.push({
        label: service.name,
        message: "EA no tiene precio para este servicio. Escribe el total a mano.",
      });
    }

    items.push({
      kind: "servicio",
      eaServiceId: service.eaServiceId,
      pricingId: service.pricingId,
      qty: 1,
      unitPriceSnapshot: service.listPrice ?? 0,
    });
  }

  for (const service of catalog.services) {
    const qty = draft.extras[String(service.eaServiceId)] ?? 0;
    if (qty <= 0) continue;

    if (service.listPrice === null) {
      flags.push({
        label: service.name,
        message: "EA no tiene precio para este adicional. Escribe el total a mano.",
      });
    }

    items.push({
      kind: "adicional",
      eaServiceId: service.eaServiceId,
      pricingId: service.pricingId,
      qty,
      unitPriceSnapshot: service.listPrice ?? 0,
    });
  }

  for (const key of Object.keys(draft.extras)) {
    const qty = draft.extras[key];
    if (qty <= 0) continue;
    if (catalog.services.some((s) => String(s.eaServiceId) === key)) continue;
    flags.push({
      label: `Adicional #${key}`,
      message: "Ya no está en el catálogo de EA. No se cobró; revisa la cuenta.",
    });
  }

  if (draft.manual !== null) {
    items.push({
      kind: "manual",
      qty: 1,
      unitPriceSnapshot: draft.manual.amount,
      note: draft.manual.note,
    });
  }

  return { items, flags };
}

/**
 * El borrador valorado, con todo lo que impide guardarlo.
 *
 * **Nunca lanza.** La hoja tiene que poder pintar un total a medio armar entre
 * dos clientas; una excepción en el render dejaría la pantalla en blanco con el
 * trabajo adentro. Los errores que `lib/ticket.ts` levanta se recogen y se
 * muestran con el texto que él escribió, para que la regla siga viviendo en un
 * solo lugar.
 *
 * El total se calcula aunque falte el motivo del descuento: la técnica escribe
 * la cifra y *después* elige por qué. Lo que falta bloquea el guardado, no la
 * vista.
 */
export function priceDraft(
  draft: TicketDraft,
  catalog: TicketCatalog,
  pricing: TicketPricing,
): DraftPricing {
  const { items, flags } = draftToItems(draft, catalog, pricing);
  const errors: string[] = [];

  if (draft.houseCourtesy) {
    // La cortesía tiene su propia puerta en `lib/ticket.ts`, la misma que usa
    // el servidor: el total escrito y el motivo no aplican, y la propina y el
    // método de pago se rechazan con el texto de allá.
    let courtesy: TicketTotals | null = null;

    try {
      courtesy = houseCourtesyTicket(items);
    } catch (error) {
      errors.push(messageOf(error));
    }

    if (courtesy !== null) {
      try {
        validateHouseCourtesyClose({ items, tip: draft.tip, payments: draft.payments });
      } catch (error) {
        errors.push(messageOf(error));
      }
    }

    return {
      items,
      flags,
      subtotal: courtesy?.subtotal ?? null,
      totals: courtesy,
      errors,
      availablePromo: null,
      promo: null,
      varianceReasonCode: "cortesia",
    };
  }

  let base: TicketTotals | null = null;

  try {
    base = computeTicketTotals(items, 0, Math.max(draft.tip, 0));
  } catch (error) {
    return {
      items,
      flags,
      subtotal: null,
      totals: null,
      errors: [messageOf(error)],
      availablePromo: null,
      promo: null,
      varianceReasonCode: null,
    };
  }

  const subtotal = base.subtotal;
  const resolved = resolveDiscount(draft, items, subtotal, pricing);
  let discount = resolved.discount;

  // Solo un total escrito puede dejar el descuento negativo: la promo nunca.
  if (discount < 0) {
    // El mensaje lo escribe B1 y no este archivo: `ticketFromEnteredTotal()`
    // es quien decide que cobrar de más va como renglón, y repetir la frase
    // acá sería una segunda versión de la regla esperando a divergir.
    errors.push(
      `El total ingresado (${draft.totalOverride}) supera el subtotal (${subtotal}). ` +
        "Cobrar de más va como un renglón, no como un total suelto.",
    );
    discount = 0;
  }

  let totals: TicketTotals | null = null;

  try {
    totals = computeTicketTotals(items, discount, Math.max(draft.tip, 0));
  } catch (error) {
    errors.push(messageOf(error));
  }

  if (totals !== null) {
    try {
      validateTicketClose({
        items,
        discount,
        tip: Math.max(draft.tip, 0),
        varianceReasonCode: resolved.varianceReasonCode,
        varianceReason: resolved.varianceReason,
      });
    } catch (error) {
      errors.push(messageOf(error));
    }
  }

  return {
    items,
    flags,
    subtotal,
    totals,
    errors,
    availablePromo: resolved.availablePromo,
    promo: resolved.promo,
    varianceReasonCode: resolved.varianceReasonCode,
  };
}

// ---------------------------------------------------------------------------
// Servicios agregados
// ---------------------------------------------------------------------------

/** Cuántos servicios se pueden agregar al principal. Más es un dedo pegado. */
export const MAX_ADDITIONAL_SERVICES = 4;

/** Agrega un servicio hecho además del principal. */
export function addService(draft: TicketDraft, eaServiceId: number, now = Date.now()): TicketDraft {
  if (draft.additionalServices.length >= MAX_ADDITIONAL_SERVICES) return draft;
  return { ...draft, additionalServices: [...draft.additionalServices, eaServiceId], updatedAt: now };
}

/** Quita el servicio agregado en la posición `index`. */
export function removeService(draft: TicketDraft, index: number, now = Date.now()): TicketDraft {
  return {
    ...draft,
    additionalServices: draft.additionalServices.filter((_, i) => i !== index),
    updatedAt: now,
  };
}

/**
 * Cobrar dos servicios como **el combo** que forman: el principal pasa a ser el
 * combo y el agregado sale de la cuenta. El precio es el del combo, que fija la
 * dueña; acá no se suma nada.
 */
export function mergeIntoCombo(
  draft: TicketDraft,
  index: number,
  comboEaServiceId: number,
  now = Date.now(),
): TicketDraft {
  return { ...removeService(draft, index, now), performedServiceId: comboEaServiceId };
}

// ---------------------------------------------------------------------------
// Vocabulario de pantalla
// ---------------------------------------------------------------------------

/**
 * La lista corta de motivos. Es la del plan y la del enum de A2, en el orden en
 * que aparecen en un salón: primero lo que pasa todos los días.
 */
export const VARIANCE_REASONS: ReadonlyArray<{
  code: VarianceReasonCode;
  label: string;
}> = [
  { code: "cambio_servicio", label: "Cambió el servicio" },
  { code: "adicionales", label: "Adicionales" },
  { code: "cortesia", label: "Cortesía" },
  { code: "correccion", label: "Corrección" },
  { code: "otro", label: "Otro" },
];

export const PAYMENT_METHODS: ReadonlyArray<{
  method: PaymentMethod;
  label: string;
}> = [
  { method: "efectivo", label: "Efectivo" },
  { method: "transferencia", label: "Transferencia" },
  { method: "otro", label: "Otro" },
];

/**
 * Chips de arranque de las observaciones.
 *
 * Son el texto del plan, palabra por palabra. No son categorías ni etiquetas:
 * se pegan al campo libre y se pueden editar. El objetivo es que el caso más
 * común cueste un toque y no treinta caracteres escritos con una mano.
 */
export const NOTE_CHIPS: readonly string[] = [
  "cambió de servicio",
  "uña repuesta sin cobro",
  "llegó tarde",
  "alergia",
];

/** Pega un chip al final del texto, sin duplicarlo ni dejar puntuación suelta. */
export function appendNoteChip(current: string, chip: string): string {
  const trimmed = current.trim();
  if (trimmed === "") return chip;
  if (trimmed.toLowerCase().includes(chip.toLowerCase())) return current;
  return `${trimmed.replace(/[.,;\s]+$/, "")}, ${chip}`;
}
