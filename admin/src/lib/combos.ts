/**
 * Los combos, del lado de quien los elige.
 *
 * ## Un combo no se elige: se compone
 *
 * En la vitrina un combo es una fila más ("Semipermanente manos + pies"), y esa
 * es exactamente la forma que **no** sirve para agendar. Quien atiende el
 * teléfono piensa "semipermanente en manos… ah, y pies también", no "combo
 * número cuatro". Buscar el combo correcto en una lista de veinticinco
 * servicios, cuando ya se eligió una de sus dos mitades, es trabajo que la
 * agenda existe para ahorrar — y el que no se hace es el que termina agendando
 * dos citas sueltas y cobrando la suma.
 *
 * Así que las dos pantallas que agendan —la agenda del panel y el flujo público
 * de la landing— **esconden los combos de la lista** y los alcanzan al revés:
 * se elige el servicio de manos, se ofrece el de pies que lo acompaña, y la
 * cita resultante es el combo.
 *
 * ## Precio y duración son del combo, no de la suma
 *
 * Es la regla de `db/migrations/010-combo.ts` y no se toca: un combo cuesta y
 * dura *menos* que sus partes, y cuánto menos es criterio de la dueña. Acá no
 * se suma nada para decidir qué se cobra. La suma sí se calcula, pero para una
 * sola cosa: mostrarla **tachada** al lado del precio del combo, para que el
 * descuento se vea en vez de quedar implícito. Ver `comboSavings()`.
 *
 * ## Puro a propósito
 *
 * Este módulo no lee la base ni llama a EA: recibe composiciones ya resueltas a
 * ids de EA (`lib/combo-source.ts` las trae) y servicios ya cargados. Tiene que
 * poder correr en el navegador, porque la resolución del par ocurre mientras
 * alguien mueve un `<select>`.
 */

/**
 * Un combo, ya traducido a ids de Easy!Appointments.
 *
 * Los tres ids son de EA y no de la vitrina: quien consume esto está armando
 * una cita, y la cita se guarda con `serviceId` de EA. La traducción la hace
 * `lib/combo-source.ts` con `service_map`.
 */
export type ComboComposition = {
  /** El servicio de EA que **es** el combo. Es lo que se agenda. */
  eaServiceId: number;
  handsEaServiceId: number;
  feetEaServiceId: number;
};

/** Lo mínimo que hace falta saber de un servicio para componer y comparar. */
export type ComboPart = {
  id: number;
  name: string;
  priceCOP: number | null;
  durationMin: number | null;
};

/** Qué papel juega un servicio dentro de los combos que existen. */
export type ComboRole = "hands" | "feet";

/**
 * El combo que resulta de un par, o `null` si ese par no es un combo.
 *
 * El orden de los argumentos no importa: quien elige puede empezar por los pies.
 */
export function findCombo(
  combos: readonly ComboComposition[],
  a: number | null,
  b: number | null,
): ComboComposition | null {
  if (a === null || b === null || a === b) return null;

  return (
    combos.find(
      (combo) =>
        (combo.handsEaServiceId === a && combo.feetEaServiceId === b) ||
        (combo.handsEaServiceId === b && combo.feetEaServiceId === a),
    ) ?? null
  );
}

/** ¿Este servicio es la mitad de algún combo? */
export function roleOf(
  combos: readonly ComboComposition[],
  eaServiceId: number | null,
): ComboRole | null {
  if (eaServiceId === null) return null;
  if (combos.some((c) => c.handsEaServiceId === eaServiceId)) return "hands";
  if (combos.some((c) => c.feetEaServiceId === eaServiceId)) return "feet";
  return null;
}

/**
 * Con qué se puede acompañar un servicio.
 *
 * Devuelve los **ids de EA de la otra mitad** de cada combo que incluye a este
 * servicio. Es lo que llena el segundo selector, y por eso se ofrece solo lo
 * que existe: un par sin combo no tiene precio ni duración que mostrar, y
 * ofrecerlo sería ofrecer un callejón sin salida.
 */
export function partnersFor(
  combos: readonly ComboComposition[],
  eaServiceId: number | null,
): number[] {
  if (eaServiceId === null) return [];

  const out: number[] = [];
  for (const combo of combos) {
    if (combo.handsEaServiceId === eaServiceId) out.push(combo.feetEaServiceId);
    else if (combo.feetEaServiceId === eaServiceId) out.push(combo.handsEaServiceId);
  }
  return [...new Set(out)];
}

/** Los ids de EA de todos los servicios que **son** un combo. */
export function comboServiceIds(combos: readonly ComboComposition[]): Set<number> {
  return new Set(combos.map((c) => c.eaServiceId));
}

/**
 * Lo que la pantalla necesita para dibujar "antes y después".
 *
 * `parts*` es la suma de las dos mitades y existe **solo** para tacharla.
 * `combo*` es lo que de verdad se cobra y lo que de verdad dura. `saving` puede
 * dar cero —o negativo, si alguien sube el precio del combo por encima de sus
 * partes— y en ese caso la pantalla no debe tachar nada: un tachado que no
 * ahorra nada es publicidad falsa dentro del propio panel.
 */
export type ComboQuote = {
  combo: ComboComposition;
  hands: ComboPart;
  feet: ComboPart;
  /** `null` si a alguna de las dos partes EA no le sabe el precio. */
  partsPriceCOP: number | null;
  /** `null` si a alguna de las dos partes EA no le sabe la duración. */
  partsDurationMin: number | null;
  comboPriceCOP: number | null;
  comboDurationMin: number | null;
  /** `partsPrice − comboPrice`. `null` cuando falta alguno de los dos. */
  saving: number | null;
  /** Hay un ahorro real que vale la pena mostrar tachado. */
  discounted: boolean;
};

/**
 * Arma la cotización de un par.
 *
 * Devuelve `null` cuando el par no es un combo o cuando alguno de los tres
 * servicios no está en el catálogo que se pasó — una composición que apunta a
 * un servicio que EA ya no tiene es un dato viejo, y cotizarlo a medias sería
 * mostrar un precio que nadie puede cobrar.
 */
export function quoteCombo(
  combos: readonly ComboComposition[],
  services: readonly ComboPart[],
  a: number | null,
  b: number | null,
): ComboQuote | null {
  const combo = findCombo(combos, a, b);
  if (!combo) return null;

  const byId = new Map(services.map((s) => [s.id, s]));
  const hands = byId.get(combo.handsEaServiceId);
  const feet = byId.get(combo.feetEaServiceId);
  const whole = byId.get(combo.eaServiceId);
  if (!hands || !feet || !whole) return null;

  const partsPriceCOP = sum(hands.priceCOP, feet.priceCOP);
  const partsDurationMin = sum(hands.durationMin, feet.durationMin);
  const comboPriceCOP = whole.priceCOP;
  const saving =
    partsPriceCOP === null || comboPriceCOP === null ? null : partsPriceCOP - comboPriceCOP;

  return {
    combo,
    hands,
    feet,
    partsPriceCOP,
    partsDurationMin,
    comboPriceCOP,
    comboDurationMin: whole.durationMin,
    saving,
    discounted: saving !== null && saving > 0,
  };
}

// ---------------------------------------------------------------------------
// El estado del par, derivado
// ---------------------------------------------------------------------------

/** Las dos mitades que hay que mostrar, sacadas del servicio que la cita tiene. */
export type ComposeState = {
  /** Lo que va en el selector principal. `null` = todavía no se eligió nada. */
  baseId: number | null;
  /** Lo que va en el segundo selector. `null` = no hay acompañante elegido. */
  partnerId: number | null;
  /** El combo que resultó del par, o `null` si lo elegido es un servicio suelto. */
  composed: ComboComposition | null;
};

/**
 * De "qué servicio tiene la cita" a "qué muestran los dos selectores".
 *
 * El par se **deriva** del servicio guardado en vez de vivir en su propio
 * estado, y eso no es purismo: con dos estados paralelos existe el instante en
 * que el par dice una cosa y el servicio que se va a guardar dice otra, y ese
 * instante es exactamente cuando alguien aprieta Guardar. Derivándolo, abrir una
 * cita vieja de combo la muestra compuesta sin reconstruir nada.
 *
 * `firstPick` es lo único que sí es estado, y sirve para una sola cosa: que la
 * lista principal no salte sola de "pies" a "manos" debajo del cursor cuando se
 * elige el acompañante. Sin él, quien empieza por los pies ve cómo su elección
 * se mueve al segundo selector al terminar.
 */
export function composeFrom(
  combos: readonly ComboComposition[],
  serviceId: number | null,
  firstPick: number | null,
): ComposeState {
  const composed = combos.find((c) => c.eaServiceId === serviceId) ?? null;
  if (!composed) return { baseId: serviceId, partnerId: null, composed: null };

  const baseId =
    firstPick === composed.feetEaServiceId
      ? composed.feetEaServiceId
      : composed.handsEaServiceId;

  const partnerId =
    baseId === composed.handsEaServiceId
      ? composed.feetEaServiceId
      : composed.handsEaServiceId;

  return { baseId, partnerId, composed };
}

/**
 * Qué servicio hay que guardar cuando se pone o se quita el acompañante.
 *
 * Poner uno convierte la cita en **el combo**: otro id, con su propio precio y
 * su propia duración. Quitarlo la devuelve al servicio suelto.
 *
 * Un par que no forma combo cae al servicio base en vez de inventar nada. No
 * debería ocurrir —el segundo selector solo ofrece acompañantes reales— pero si
 * ocurre, quedarse con lo que la persona ya eligió es mejor que dejar la cita
 * sin servicio.
 */
export function pairedServiceId(
  combos: readonly ComboComposition[],
  baseId: number | null,
  partnerId: number | null,
): number | null {
  if (partnerId === null) return baseId;
  return findCombo(combos, baseId, partnerId)?.eaServiceId ?? baseId;
}

/** Suma que se rinde ante un dato que falta, en vez de tratarlo como cero. */
function sum(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}
