import { describe, expect, it } from "vitest";

import {
  comboServiceIds,
  composeFrom,
  findCombo,
  pairedServiceId,
  partnersFor,
  quoteCombo,
  roleOf,
  type ComboComposition,
  type ComboPart,
} from "./combos";

/**
 * Los combos, del lado de quien los compone.
 *
 * Lo que estos tests protegen, en una línea: **el precio y la duración salen
 * del combo, nunca de la suma**. La suma solo existe para tacharla. Un cambio
 * que la use como fuente pasa desapercibido en pantalla —el número se ve
 * razonable— y cobra de más en cada combo del año.
 */

// Semipermanente manos (50.000 / 60) + semipermanente pies (55.000 / 75) =
// 105.000 y 135 minutos. El combo son 95.000 y 120: más barato y más corto,
// como en `src/data/pricing.ts` de verdad.
const COMBOS: ComboComposition[] = [
  { eaServiceId: 90, handsEaServiceId: 10, feetEaServiceId: 20 },
  { eaServiceId: 91, handsEaServiceId: 11, feetEaServiceId: 20 },
];

const SERVICES: ComboPart[] = [
  { id: 10, name: "Semipermanente manos", priceCOP: 50000, durationMin: 60 },
  { id: 11, name: "Forrado en acrílico", priceCOP: 85000, durationMin: 90 },
  { id: 20, name: "Semipermanente pies", priceCOP: 55000, durationMin: 75 },
  { id: 30, name: "Acrílicas esculpidas", priceCOP: 115000, durationMin: 150 },
  { id: 90, name: "Semipermanente manos + pies", priceCOP: 95000, durationMin: 120 },
  { id: 91, name: "Forrado manos + semi pies", priceCOP: 125000, durationMin: 150 },
];

describe("findCombo", () => {
  it("encuentra el combo del par", () => {
    expect(findCombo(COMBOS, 10, 20)?.eaServiceId).toBe(90);
  });

  it("no le importa el orden: se puede empezar por los pies", () => {
    expect(findCombo(COMBOS, 20, 10)?.eaServiceId).toBe(90);
  });

  it("devuelve null para un par que no es combo", () => {
    expect(findCombo(COMBOS, 30, 20)).toBeNull();
  });

  it("devuelve null con una mitad sin elegir", () => {
    expect(findCombo(COMBOS, 10, null)).toBeNull();
    expect(findCombo(COMBOS, null, null)).toBeNull();
  });

  it("no arma un combo de un servicio consigo mismo", () => {
    expect(findCombo(COMBOS, 10, 10)).toBeNull();
  });
});

describe("roleOf y partnersFor", () => {
  it("sabe de qué lado está cada mitad", () => {
    expect(roleOf(COMBOS, 10)).toBe("hands");
    expect(roleOf(COMBOS, 20)).toBe("feet");
    expect(roleOf(COMBOS, 30)).toBeNull();
  });

  it("ofrece solo lo que forma un combo de verdad", () => {
    // Un par sin combo no tiene precio ni duración que mostrar: ofrecerlo sería
    // un callejón sin salida al final del formulario.
    expect(partnersFor(COMBOS, 30)).toEqual([]);
    expect(partnersFor(COMBOS, 10)).toEqual([20]);
  });

  it("desde los pies ofrece las dos manos que los acompañan", () => {
    expect(partnersFor(COMBOS, 20)).toEqual([10, 11]);
  });

  it("no repite un acompañante que aparece en dos combos", () => {
    const dobles: ComboComposition[] = [
      ...COMBOS,
      { eaServiceId: 92, handsEaServiceId: 10, feetEaServiceId: 20 },
    ];
    expect(partnersFor(dobles, 10)).toEqual([20]);
  });

  it("sin servicio elegido no hay papel ni acompañantes", () => {
    // Es el estado en el que el formulario abre. Sin esta rama, `roleOf` con
    // `null` buscaría un `undefined` en la lista y `partnersFor` devolvería
    // acompañantes de la nada.
    expect(roleOf(COMBOS, null)).toBeNull();
    expect(partnersFor(COMBOS, null)).toEqual([]);
  });

  it("enumera los servicios que hay que esconder de la lista", () => {
    expect(comboServiceIds(COMBOS)).toEqual(new Set([90, 91]));
  });
});

describe("quoteCombo", () => {
  it("cobra el precio del combo y muestra la suma aparte", () => {
    const quote = quoteCombo(COMBOS, SERVICES, 10, 20);

    expect(quote).not.toBeNull();
    // Lo que se cobra y lo que dura: del combo.
    expect(quote!.comboPriceCOP).toBe(95000);
    expect(quote!.comboDurationMin).toBe(120);
    // Lo que se tacha: la suma de las partes, que nunca decide nada.
    expect(quote!.partsPriceCOP).toBe(105000);
    expect(quote!.partsDurationMin).toBe(135);
    expect(quote!.saving).toBe(10000);
    expect(quote!.discounted).toBe(true);
  });

  it("no tacha nada cuando el combo no ahorra", () => {
    // Un combo que cuesta lo mismo que sus partes es legítimo; tacharle un
    // precio idéntico al lado sería publicidad falsa dentro del propio panel.
    const services = SERVICES.map((s) => (s.id === 90 ? { ...s, priceCOP: 105000 } : s));
    const quote = quoteCombo(COMBOS, services, 10, 20);

    expect(quote!.saving).toBe(0);
    expect(quote!.discounted).toBe(false);
  });

  it("tampoco tacha si alguien puso el combo más caro que sus partes", () => {
    const services = SERVICES.map((s) => (s.id === 90 ? { ...s, priceCOP: 120000 } : s));
    const quote = quoteCombo(COMBOS, services, 10, 20);

    expect(quote!.saving).toBe(-15000);
    expect(quote!.discounted).toBe(false);
  });

  it("se rinde ante un precio que EA no sabe, en vez de contarlo como cero", () => {
    const services = SERVICES.map((s) => (s.id === 20 ? { ...s, priceCOP: null } : s));
    const quote = quoteCombo(COMBOS, services, 10, 20);

    expect(quote!.partsPriceCOP).toBeNull();
    expect(quote!.saving).toBeNull();
    expect(quote!.discounted).toBe(false);
    // Lo del combo sí se sabe, y es lo que de verdad se cobra.
    expect(quote!.comboPriceCOP).toBe(95000);
  });

  it("devuelve null si el servicio del combo ya no está en el catálogo", () => {
    // Composición vieja contra un EA donde el combo se borró: cotizarlo a
    // medias mostraría un precio que nadie puede cobrar.
    const services = SERVICES.filter((s) => s.id !== 90);
    expect(quoteCombo(COMBOS, services, 10, 20)).toBeNull();
  });

  it("devuelve null para un par que no es combo", () => {
    expect(quoteCombo(COMBOS, SERVICES, 30, 20)).toBeNull();
  });
});

describe("composeFrom", () => {
  it("un servicio suelto es la base y no tiene acompañante", () => {
    expect(composeFrom(COMBOS, 30, null)).toEqual({
      baseId: 30,
      partnerId: null,
      composed: null,
    });
  });

  it("sin servicio elegido no inventa una base", () => {
    expect(composeFrom(COMBOS, null, null)).toEqual({
      baseId: null,
      partnerId: null,
      composed: null,
    });
  });

  it("una cita que YA es un combo se abre compuesta", () => {
    // Es el caso de editar una cita vieja: el par no se guarda en ningún lado,
    // se deduce del servicio. Sin esto, abrirla mostraría un combo suelto en la
    // lista y perdería sus dos mitades.
    expect(composeFrom(COMBOS, 90, null)).toEqual({
      baseId: 10,
      partnerId: 20,
      composed: COMBOS[0],
    });
  });

  it("respeta que se haya empezado por los pies", () => {
    // Sin `firstPick`, elegir "pies" y luego "manos" hacía que la elección
    // saltara sola al segundo selector debajo del cursor.
    expect(composeFrom(COMBOS, 90, 20)).toEqual({
      baseId: 20,
      partnerId: 10,
      composed: COMBOS[0],
    });
  });

  it("un `firstPick` que no es parte de ese combo no lo desordena", () => {
    // Queda el orden por defecto (manos primero) en vez de un par incoherente.
    expect(composeFrom(COMBOS, 90, 999)).toEqual({
      baseId: 10,
      partnerId: 20,
      composed: COMBOS[0],
    });
  });

  it("sin composiciones cargadas, el combo se comporta como servicio suelto", () => {
    // Es lo que pasa si `service_map` no se pudo leer: la cita conserva su
    // servicio y sigue siendo guardable. Perder el servicio sería destruir el
    // dato por no poder adornarlo.
    expect(composeFrom([], 90, null)).toEqual({
      baseId: 90,
      partnerId: null,
      composed: null,
    });
  });
});

describe("pairedServiceId", () => {
  it("poner el acompañante convierte la cita en el combo", () => {
    expect(pairedServiceId(COMBOS, 10, 20)).toBe(90);
  });

  it("y quitarlo la devuelve al servicio suelto", () => {
    expect(pairedServiceId(COMBOS, 10, null)).toBe(10);
  });

  it("desde los pies llega al mismo combo", () => {
    expect(pairedServiceId(COMBOS, 20, 10)).toBe(90);
  });

  it("un par que no es combo se queda con lo que ya se había elegido", () => {
    // No debería poder ocurrir —el segundo selector solo ofrece acompañantes
    // reales— pero dejar la cita sin servicio sería peor que ignorar el par.
    expect(pairedServiceId(COMBOS, 30, 20)).toBe(30);
  });

  it("sin base no devuelve nada que guardar", () => {
    expect(pairedServiceId(COMBOS, null, 20)).toBeNull();
  });
});

describe("componer y descomponer es reversible", () => {
  it("volver de un combo a su mitad deja exactamente la mitad", () => {
    // El ciclo completo: elegir manos → agregar pies → quitar pies. Si esto no
    // cerrara, quitar el acompañante dejaría la cita en el combo y se cobraría
    // un combo por un servicio suelto.
    for (const combo of COMBOS) {
      const conCombo = pairedServiceId(COMBOS, combo.handsEaServiceId, combo.feetEaServiceId);
      expect(conCombo).toBe(combo.eaServiceId);

      const { baseId, partnerId } = composeFrom(COMBOS, conCombo, combo.handsEaServiceId);
      expect(baseId).toBe(combo.handsEaServiceId);
      expect(partnerId).toBe(combo.feetEaServiceId);
      expect(pairedServiceId(COMBOS, baseId, null)).toBe(combo.handsEaServiceId);
    }
  });
});
