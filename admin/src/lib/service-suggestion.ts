import { COMBO_COMPOSITION, type ComboCompositionEntry } from "@/data/combo-composition";
import { SERVICE_NAMES } from "@/data/service-names";

/**
 * Qué servicio sugerirle a una clienta al agendarla, a partir de lo que se hizo
 * la última vez.
 *
 * El caso que lo justifica es el retoque: quien agenda por teléfono tiene que
 * saber **de qué sistema** es el retoque, y la clienta casi nunca lo dice
 * ("vengo a retocarme"). La regla es una sola y es la del estudio:
 *
 * - Si la última visita atendida fue un montaje, un forrado o un retoque de un
 *   sistema (polygel, acrílico, builder gel), toca **el retoque de ese
 *   sistema**. Un combo cuenta por su mitad de manos: el forrado polygel +
 *   semi pies se retoca como polygel.
 * - Si no, se sugiere **repetir** lo mismo.
 * - Si nada de eso existe hoy en EA, no hay sugerencia. Sugerir un servicio que
 *   no se puede agendar es peor que no sugerir nada.
 *
 * Es puro: no lee EA ni la base. Recibe el catálogo vigente (servicios de EA y
 * `service_map`) ya leído, y las visitas ya filtradas a las atendidas. Nunca
 * toca plata, y por eso puede leer el historial de Agenda Pro sin cruzarse con
 * `legacy-history.money-paths.test.ts`: no lo importa, solo recibe nombres.
 *
 * ## El historial de Agenda Pro solo trae el nombre
 *
 * Una fila de EA trae el id del servicio (el realizado, si se cerró la cuenta),
 * y con `service_map` se sabe exactamente qué es. Una de Agenda Pro trae texto
 * libre escrito a mano: "Retoque polygel", "Acrílicas esculpidas", "Uñas
 * acrílicas". Ese texto se clasifica por palabras (`classifyServiceName()`), lo
 * mejor que se puede; si no se reconoce, la tarjeta muestra el historial igual
 * y simplemente no ofrece el botón.
 */

export type NailSystem = "polygel" | "acrylic" | "builder-gel";

/** De qué sistema es cada servicio de la vitrina que lleva uno. */
const SYSTEM_OF_PRICING: Readonly<Record<string, NailSystem>> = {
  "polygel-sculpted": "polygel",
  "polygel-dual": "polygel",
  "polygel-overlay": "polygel",
  "polygel-refill": "polygel",
  "acrylic-sculpted": "acrylic",
  "acrylic-overlay": "acrylic",
  "acrylic-refill": "acrylic",
  "builder-gel-dual": "builder-gel",
  "builder-gel-overlay": "builder-gel",
  "builder-gel-refill": "builder-gel",
};

/** El retoque de cada sistema, en ids de `src/data/pricing.ts`. */
export const RETOUCH_OF_SYSTEM: Readonly<Record<NailSystem, string>> = {
  polygel: "polygel-refill",
  acrylic: "acrylic-refill",
  "builder-gel": "builder-gel-refill",
};

/** Cómo se dice el sistema en el botón. */
const SYSTEM_LABEL: Readonly<Record<NailSystem, string>> = {
  polygel: "Polygel",
  acrylic: "Acrílico",
  "builder-gel": "Builder gel",
};

/** `"  Retoque  ACRÍLICO "` → `"retoque acrilico"`. */
export function normalizeServiceName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Nombre normalizado de la vitrina → id. Para el calce exacto, que va primero. */
const PRICING_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(SERVICE_NAMES).map(([id, name]) => [normalizeServiceName(name), id]),
);

/**
 * La mitad de manos de un combo, o el mismo id si no es combo.
 *
 * El retoque se decide por las manos: los pies de un combo son semipermanente
 * o tradicional, que no se retocan.
 */
export function handsHalfOf(
  pricingId: string,
  combos: readonly ComboCompositionEntry[] = COMBO_COMPOSITION,
): string {
  return combos.find((combo) => combo.pricingId === pricingId)?.hands ?? pricingId;
}

/** El sistema de un id de vitrina (combos incluidos), o `null`. */
export function systemOfPricingId(
  pricingId: string,
  combos: readonly ComboCompositionEntry[] = COMBO_COMPOSITION,
): NailSystem | null {
  return SYSTEM_OF_PRICING[handsHalfOf(pricingId, combos)] ?? null;
}

export type ServiceNameClass = {
  /** El id de vitrina, si el nombre lo identifica sin ambigüedad. */
  pricingId: string | null;
  /** El sistema, aunque no se sepa cuál servicio exacto ("Uñas acrílicas"). */
  system: NailSystem | null;
  /** Dice "retoque" (o "relleno", "mantenimiento"). */
  isRetouch: boolean;
};

type Kind = "refill" | "dual" | "sculpted" | "overlay";

/**
 * Clasifica un nombre de servicio escrito a mano.
 *
 * Primero el calce exacto contra los nombres de la vitrina; después, por
 * palabras: qué sistema nombra y qué clase de trabajo. Un **retiro** no es un
 * trabajo del sistema aunque lo nombre ("Retiro de acrílico"): quien se lo
 * quitó no viene a retocarlo.
 */
export function classifyServiceName(name: string | null | undefined): ServiceNameClass {
  const n = normalizeServiceName(name);
  if (n === "") return { pricingId: null, system: null, isRetouch: false };

  const exact = PRICING_BY_NAME.get(n) ?? null;
  if (exact !== null) {
    return {
      pricingId: exact,
      system: systemOfPricingId(exact),
      isRetouch: exact.endsWith("-refill"),
    };
  }

  if (/\bretir|\bremoc|\bremov/.test(n)) {
    return { pricingId: null, system: null, isRetouch: false };
  }

  const system: NailSystem | null = /poly ?gel/.test(n)
    ? "polygel"
    : /builder|\bbgel\b/.test(n)
      ? "builder-gel"
      : /acril|acryl/.test(n)
        ? "acrylic"
        : null;

  const kind: Kind | null = /retoque|relleno|mantenimiento|refill/.test(n)
    ? "refill"
    : /\bdual\b/.test(n)
      ? "dual"
      : /esculp|sculpt|extensi|alarg/.test(n)
        ? "sculpted"
        : /forrad|overlay/.test(n)
          ? "overlay"
          : null;

  const candidate = system !== null && kind !== null ? `${system}-${kind}` : null;
  return {
    pricingId: candidate !== null && candidate in SYSTEM_OF_PRICING ? candidate : null,
    system,
    isRetouch: kind === "refill",
  };
}

// ---------------------------------------------------------------------------
// La sugerencia
// ---------------------------------------------------------------------------

/** Una visita atendida, como la necesita la sugerencia. */
export type SuggestionVisit = {
  serviceName: string;
  /** Id de EA (el realizado si hubo cuenta). `null` en Agenda Pro. */
  serviceId: number | null;
};

export type SuggestionCatalog = {
  /** Los servicios de EA que existen hoy. Solo se sugiere uno de estos. */
  services: ReadonlyArray<{ id: number; name: string | null }>;
  /** `service_map`: id de vitrina → id de EA. */
  eaIdOfPricing: ReadonlyMap<string, number>;
  combos?: readonly ComboCompositionEntry[];
};

export type ServiceSuggestion = {
  /** Id de EA, listo para el selector del formulario. */
  serviceId: number;
  /** El texto del botón. */
  label: string;
  /** Por qué, en una línea. */
  reason: string;
  kind: "retoque" | "repetir";
};

type Resolved = { pricingId: string | null; system: NailSystem | null; isRetouch: boolean };

/**
 * La sugerencia para la próxima cita, o `null`.
 *
 * `visits` son las **atendidas**, de la más reciente a la más vieja: una
 * inasistencia no dice qué tiene puesto la clienta. Solo decide la más
 * reciente, con una excepción: un "Retoque" a secas de Agenda Pro no dice el
 * sistema, y entonces se busca en las visitas anteriores — si antes de ese
 * retoque hubo un montaje en polygel, el retoque era de polygel.
 */
export function suggestService(
  visits: readonly SuggestionVisit[],
  catalog: SuggestionCatalog,
): ServiceSuggestion | null {
  const last = visits[0];
  if (last === undefined) return null;

  const combos = catalog.combos ?? COMBO_COMPOSITION;
  const pricingOfEa = new Map<number, string>();
  for (const [pricingId, eaId] of catalog.eaIdOfPricing) pricingOfEa.set(eaId, pricingId);

  const bookable = new Map<number, string | null>(catalog.services.map((s) => [s.id, s.name]));
  const eaIdByName = new Map<string, number>();
  for (const service of catalog.services) {
    const key = normalizeServiceName(service.name);
    if (key !== "" && !eaIdByName.has(key)) eaIdByName.set(key, service.id);
  }

  const resolve = (visit: SuggestionVisit): Resolved => {
    const mapped = visit.serviceId === null ? undefined : pricingOfEa.get(visit.serviceId);
    if (mapped !== undefined) {
      const hands = handsHalfOf(mapped, combos);
      return {
        pricingId: mapped,
        system: SYSTEM_OF_PRICING[hands] ?? null,
        isRetouch: hands.endsWith("-refill"),
      };
    }
    // Sin `service_map` (un servicio de EA sin vincular, o Agenda Pro): por el
    // nombre. Si el nombre es igual al de un servicio de EA vinculado, eso gana.
    const byEaName = eaIdByName.get(normalizeServiceName(visit.serviceName));
    const viaEaName = byEaName === undefined ? undefined : pricingOfEa.get(byEaName);
    if (viaEaName !== undefined) return resolve({ ...visit, serviceId: byEaName ?? null });
    return classifyServiceName(visit.serviceName);
  };

  const head = resolve(last);
  let system = head.system;
  if (system === null && head.isRetouch) {
    for (const older of visits.slice(1)) {
      const found = resolve(older).system;
      if (found !== null) {
        system = found;
        break;
      }
    }
  }

  const reason = `Su última visita fue ${last.serviceName}.`;

  if (system !== null) {
    const eaId = catalog.eaIdOfPricing.get(RETOUCH_OF_SYSTEM[system]);
    if (eaId === undefined || !bookable.has(eaId)) return null;
    return {
      serviceId: eaId,
      label: `Agendar retoque de ${SYSTEM_LABEL[system]}`,
      reason,
      kind: "retoque",
    };
  }

  // Repetir: el mismo servicio de EA si sigue existiendo; si no (o si es de
  // Agenda Pro), el que corresponde por vitrina o por nombre.
  const candidates: Array<number | undefined> = [
    last.serviceId ?? undefined,
    head.pricingId === null ? undefined : catalog.eaIdOfPricing.get(head.pricingId),
    eaIdByName.get(normalizeServiceName(last.serviceName)),
  ];
  const eaId = candidates.find((id) => id !== undefined && bookable.has(id));
  if (eaId === undefined) return null;

  const name = bookable.get(eaId)?.trim() || last.serviceName;
  return { serviceId: eaId, label: `Repetir: ${name}`, reason, kind: "repetir" };
}
