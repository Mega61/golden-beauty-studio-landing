/**
 * Qué precio vale para una cita, y de dónde salió.
 *
 * El precio de un servicio en EA **cambia con el tiempo**: se re-tarifa cada
 * año, y `ea_services.price` solo sabe lo que vale hoy. Valorar una cita de
 * marzo con el precio de noviembre paga una comisión equivocada sobre una plata
 * que nunca entró. Por eso el precio se congela al agendar, en la fila
 * `appointment_finance` que crea el webhook (o el reconcile).
 *
 * Este módulo resuelve el único caso interesante: **qué pasa cuando el
 * congelado no está.** EA no reintenta sus webhooks, así que un panel caído
 * diez minutos pierde los eventos de esos diez minutos; el reconcile nocturno
 * recupera casi todo, pero "casi" no es "todo".
 *
 * La respuesta es caer al precio de lista de hoy — porque una cita sin precio
 * bloquea el cierre del día — **y marcarla**. La marca es la mitad que importa:
 *
 * > Un cero silencioso es indistinguible de un cero correcto, y un precio de
 * > hoy sobre una cita vieja es indistinguible de un precio congelado. La marca
 * > es lo único que separa "aviso en Diagnóstico" de "liquidación mal pagada
 * > sin que nadie se entere".
 *
 * Por eso `flagged` no es un campo que el llamador pueda olvidar de mirar sin
 * consecuencia: `resolvePriceSnapshot()` **nunca** devuelve un precio de
 * respaldo con `flagged: false`, y el test lo verifica sobre el producto
 * cartesiano completo de entradas, no sobre tres ejemplos.
 */

import type { Cop, SnapshotSource } from "@/db/types";

/**
 * Por qué este precio no vino de un congelado limpio.
 *
 * `null` es el único valor que significa "todo bien". Los tres códigos son
 * problemas distintos con arreglos distintos: `sin-fila` es un webhook perdido
 * que el reconcile debería recuperar; `sin-snapshot` es una fila creada sin
 * precio, que apunta a un servicio borrado en EA; `sin-precio-de-lista` es que
 * ni siquiera hoy se sabe cuánto vale, y ése bloquea el cierre.
 */
export type PriceSnapshotFlag =
  | "sin-fila"
  | "sin-snapshot"
  | "sin-precio-de-lista"
  | "respaldo-previo";

/** Lo que la fila `appointment_finance` sabe del precio, si la fila existe. */
export type StoredPriceSnapshot = {
  /** `service_price_snapshot`. `null` ⇒ la fila existe pero no congeló nada. */
  price: Cop | null;
  /** `snapshot_source`. Un `fallback` guardado sigue siendo un fallback. */
  source: SnapshotSource;
};

export type PriceSnapshotInput = {
  /** `null` = no hay fila `appointment_finance` para esta cita. */
  stored: StoredPriceSnapshot | null;
  /** `ea_services.price` de hoy, o el de `pricing.ts`. `null` = tampoco hay. */
  listPrice: Cop | null;
};

/** Un precio con su marca. `flagged` es siempre `flag !== null`. */
export type ResolvedPrice = {
  price: Cop;
  /** `true` ⇔ `flag !== null`. La invariante del módulo. */
  flagged: boolean;
  flag: PriceSnapshotFlag | null;
};

/** Lo mismo, para el encabezado de la cuenta, que además guarda de dónde vino. */
export type PriceSnapshotResult = ResolvedPrice & {
  source: SnapshotSource;
};

export class PriceSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceSnapshotError";
  }
}

function assertPesos(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new PriceSnapshotError(`${what} tiene que ser un entero de pesos, y llegó ${value}`);
  }
}

/**
 * Un solo constructor para el resultado, y es el que sostiene la invariante.
 *
 * `flagged` se **deriva** de `flag` en vez de pasarse aparte. No es azúcar: un
 * booleano independiente es un booleano que alguien puede poner en `false` al
 * agregar un caso nuevo, y ese olvido no rompe ningún test que no lo esté
 * buscando. Derivado, el caso no existe.
 */
function marked(price: Cop, flag: PriceSnapshotFlag | null): ResolvedPrice {
  return { price, flagged: flag !== null, flag };
}

function result(
  price: Cop,
  source: SnapshotSource,
  flag: PriceSnapshotFlag | null,
): PriceSnapshotResult {
  return { ...marked(price, flag), source };
}

/**
 * Resuelve el precio de un servicio para una cita.
 *
 * Orden: el congelado manda; si falta, el de lista con marca; si tampoco hay,
 * cero con la marca más ruidosa. Nunca lanza por falta de datos — devolver un
 * error acá dejaría la caja sin poder abrir la cuenta, y el problema es del
 * precio, no de la cita.
 */
export function resolvePriceSnapshot(input: PriceSnapshotInput): PriceSnapshotResult {
  const { stored, listPrice } = input;

  if (listPrice !== null) {
    assertPesos(listPrice, "El precio de lista");
  }

  if (stored !== null && stored.price !== null) {
    assertPesos(stored.price, "El precio congelado");

    // La fila congeló un precio. Si ese congelado ya había sido un respaldo, la
    // marca **sobrevive**: la cita se sigue valorando con un precio que no es
    // el que regía cuando se agendó, y eso no deja de ser cierto porque alguien
    // lo haya guardado. Es la diferencia entre "se resolvió" y "se persistió".
    return result(
      stored.price,
      stored.source,
      stored.source === "fallback" ? "respaldo-previo" : null,
    );
  }

  const flag: PriceSnapshotFlag = stored === null ? "sin-fila" : "sin-snapshot";

  if (listPrice === null) {
    // Ni congelado ni lista. La cita se puede seguir viendo en la agenda, pero
    // valorada en cero, y con la marca que hace que aparezca en Diagnóstico y
    // que el cierre del día no la deje pasar como si fuera una cortesía.
    return result(0, "fallback", "sin-precio-de-lista");
  }

  return result(listPrice, "fallback", flag);
}

/**
 * Lo mismo para un renglón de la cuenta identificado por su `pricing_id`.
 *
 * Los adicionales no tienen congelado propio hasta que la cuenta se cierra —
 * se congelan en ese momento, el mismo día, así que no hay deriva posible. El
 * caso marcado acá es el otro: un `pricing_id` que ya no existe en el catálogo
 * porque el servicio se renombró o se quitó entre que se armó el borrador y se
 * envió.
 */
export function resolveListPrice(
  pricingId: string,
  catalog: ReadonlyMap<string, Cop>,
): ResolvedPrice {
  const price = catalog.get(pricingId);

  if (price === undefined) {
    return marked(0, "sin-precio-de-lista");
  }

  assertPesos(price, `El precio de lista de ${pricingId}`);

  return marked(price, null);
}
