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
  validateTicketClose,
  type TicketItemInput,
  type TicketTotals,
} from "@/lib/ticket";
import type { Cop, PaymentMethod, VarianceReasonCode } from "@/db/types";
import { findService, type TicketCatalog } from "./catalog";

/** Sube cuando la forma guardada deja de ser legible por el código nuevo. */
export const DRAFT_VERSION = 1;

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
  paymentMethod: PaymentMethod | null;
  tip: Cop;
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
};

export function emptyDraft(
  eaAppointmentId: number,
  bookedServiceId: number | null,
  now = Date.now(),
): TicketDraft {
  return {
    version: DRAFT_VERSION,
    eaAppointmentId,
    // Paso 1 del flujo: "viene con el servicio agendado ya elegido".
    performedServiceId: bookedServiceId,
    extras: {},
    manual: null,
    totalOverride: null,
    varianceReasonCode: null,
    varianceReason: "",
    notes: "",
    paymentMethod: null,
    tip: 0,
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
    paymentMethod: PaymentMethod | null;
    serviceNotes: string;
    varianceReasonCode: VarianceReasonCode | null;
    varianceReason: string;
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

  for (const item of finance.items) {
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

  return {
    version: DRAFT_VERSION,
    eaAppointmentId,
    performedServiceId: finance.performedServiceId ?? bookedServiceId,
    extras,
    manual,
    totalOverride: finance.discount > 0 ? finance.amountCharged : null,
    varianceReasonCode: finance.varianceReasonCode,
    varianceReason: finance.varianceReason,
    notes: finance.serviceNotes,
    paymentMethod: finance.paymentMethod,
    tip: finance.tip,
    updatedAt: now,
  };
}

/** ¿Hay algo escrito que se pueda perder? Decide si el panel se cierra al tocar afuera. */
export function isDirty(draft: TicketDraft, baseline: TicketDraft): boolean {
  return (
    draft.performedServiceId !== baseline.performedServiceId ||
    JSON.stringify(draft.extras) !== JSON.stringify(baseline.extras) ||
    JSON.stringify(draft.manual) !== JSON.stringify(baseline.manual) ||
    draft.totalOverride !== baseline.totalOverride ||
    draft.varianceReasonCode !== baseline.varianceReasonCode ||
    draft.varianceReason !== baseline.varianceReason ||
    draft.notes !== baseline.notes ||
    draft.paymentMethod !== baseline.paymentMethod ||
    draft.tip !== baseline.tip
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
};

function messageOf(error: unknown): string {
  if (error instanceof TicketError) return error.message;
  // Cualquier otra cosa es un bug nuestro, no un dato inválido. Se deja subir
  // en vez de disfrazarlo de mensaje de validación: un error de programación
  // que aparece en pantalla como "revisá estos campos" manda a la técnica a
  // buscar un problema que no está en la cuenta.
  throw error;
}

/**
 * El borrador convertido en los renglones que `lib/ticket.ts` sabe valorar.
 *
 * Orden fijo y no casual: **servicio realizado, adicionales en el orden del
 * catálogo, manual al final.** El prorrateo del descuento reparte el peso del
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
        message: "EA no tiene precio para este servicio. Escribí el total a mano.",
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

  for (const service of catalog.services) {
    const qty = draft.extras[String(service.eaServiceId)] ?? 0;
    if (qty <= 0) continue;

    if (service.listPrice === null) {
      flags.push({
        label: service.name,
        message: "EA no tiene precio para este adicional. Escribí el total a mano.",
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
      message: "Ya no está en el catálogo de EA. No se cobró; revisá la cuenta.",
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

  let base: TicketTotals | null = null;

  try {
    base = computeTicketTotals(items, 0, Math.max(draft.tip, 0));
  } catch (error) {
    return { items, flags, subtotal: null, totals: null, errors: [messageOf(error)] };
  }

  const subtotal = base.subtotal;
  let discount = 0;

  if (draft.totalOverride !== null) {
    discount = subtotal - draft.totalOverride;
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
        varianceReasonCode: draft.varianceReasonCode,
        varianceReason: draft.varianceReason,
      });
    } catch (error) {
      errors.push(messageOf(error));
    }
  }

  return { items, flags, subtotal, totals, errors };
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
