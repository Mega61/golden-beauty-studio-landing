import { describe, expect, it } from "vitest";

import {
  CommissionError,
  applyRule,
  computeCommissions,
  fortnightFor,
  resolveRule,
  roundPesos,
  ruleSpecificity,
  totalsByProvider,
  type CommissionInput,
  type CommissionRuleInput,
  type CommissionableLine,
} from "./commission";
import { computeTicketTotals } from "./ticket";

/**
 * ⚠ **Todas las tasas de este archivo son de fixture.** Las reglas que rigen
 * hoy no están escritas en ningún lado y son una decisión pendiente de la dueña
 * (§ Decisiones pendientes: tasas por técnica y categoría, si los adicionales
 * pagan, si hay escalonado). Los números de acá abajo están elegidos para que
 * los bordes del motor se vean —12,5 % existe justamente para probar que los
 * puntos básicos hacen falta— y **no** para parecer las tasas reales.
 */

const SOFIA = 2;
const DANIELA = 3;

const rule = (over: Partial<CommissionRuleInput> & { id: number }): CommissionRuleInput => ({
  eaProviderId: null,
  categoryId: null,
  eaServiceId: null,
  appliesTo: "ambos",
  kind: "percent",
  percentBp: 1_000,
  fixedAmount: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...over,
});

const line = (over: Partial<CommissionableLine> & { itemId: number }): CommissionableLine => ({
  kind: "servicio",
  eaServiceId: 6,
  categoryId: "montajes",
  baseAmount: 100_000,
  serviceDate: "2026-08-31",
  ...over,
});

const solo = (eaProviderId: number) => [{ eaProviderId, shareBp: 10_000 }];

describe("roundPesos — el modo de redondeo es una decisión de negocio", () => {
  it("medio peso se aleja del cero en los dos sentidos", () => {
    expect(roundPesos(0.5)).toBe(1);
    expect(roundPesos(-0.5)).toBe(-1);
    expect(roundPesos(1.5)).toBe(2);
    expect(roundPesos(2.5)).toBe(3); // no "medio par": daría 2
    expect(roundPesos(-2.5)).toBe(-3);
  });

  it("una corrección cancela exactamente el cobro que corrige", () => {
    // Es la razón de que el redondeo sea simétrico. Con `Math.round` suelto,
    // −1234,5 iría a −1234 y +1234,5 a +1235, y la corrección dejaría un peso
    // colgado en la liquidación.
    for (const value of [1_234.5, 987.5, 0.5, 12_345.5]) {
      expect(roundPesos(value) + roundPesos(-value)).toBe(0);
    }
  });

  it("nunca devuelve cero negativo", () => {
    expect(Object.is(roundPesos(-0.4), 0)).toBe(true);
    expect(Object.is(roundPesos(0), 0)).toBe(true);
  });
});

describe("precedencia de reglas", () => {
  const target = line({ itemId: 1, eaServiceId: 6, categoryId: "montajes" });

  it("la escalera completa, de la más específica a la global", () => {
    const rules = [
      rule({ id: 10 }), // global
      rule({ id: 20, categoryId: "montajes" }),
      rule({ id: 30, eaServiceId: 6 }),
      rule({ id: 40, eaProviderId: SOFIA }),
      rule({ id: 50, eaProviderId: SOFIA, categoryId: "montajes" }),
      rule({ id: 60, eaProviderId: SOFIA, eaServiceId: 6 }),
    ];

    // Se van quitando de a una desde la punta y siempre gana la siguiente.
    const esperado = [60, 50, 40, 30, 20, 10];

    for (const [index, id] of esperado.entries()) {
      expect(resolveRule(rules.slice(0, rules.length - index), target, SOFIA).rule?.id).toBe(id);
    }
  });

  it("la categoría no suma especificidad cuando ya hay servicio", () => {
    // Un servicio implica su categoría: agregarla es redundante, no más
    // específico. Sí tiene que seguir coincidiendo para que la regla aplique.
    expect(ruleSpecificity(rule({ id: 1, eaProviderId: SOFIA, eaServiceId: 6 }))).toBe(
      ruleSpecificity(rule({ id: 2, eaProviderId: SOFIA, eaServiceId: 6, categoryId: "montajes" })),
    );

    const conCategoriaEquivocada = rule({
      id: 2,
      eaProviderId: SOFIA,
      eaServiceId: 6,
      categoryId: "sencillos",
    });

    expect(resolveRule([conCategoriaEquivocada], target, SOFIA).flag).toBe("sin-regla");
  });

  it("la regla de otra técnica no aplica", () => {
    const deDaniela = rule({ id: 1, eaProviderId: DANIELA, percentBp: 2_000 });

    expect(resolveRule([deDaniela], target, SOFIA).flag).toBe("sin-regla");
    expect(resolveRule([deDaniela], target, DANIELA).rule?.id).toBe(1);
  });

  it("empate de especificidad: gana el valid_from más reciente", () => {
    const vieja = rule({ id: 1, categoryId: "montajes", validFrom: "2026-01-01" });
    const nueva = rule({ id: 2, categoryId: "montajes", validFrom: "2026-06-01" });

    expect(resolveRule([vieja, nueva], target, SOFIA).rule?.id).toBe(2);
    // El orden de la lista no puede cambiar el resultado.
    expect(resolveRule([nueva, vieja], target, SOFIA).rule?.id).toBe(2);
  });

  it("empate también en valid_from: elige determinista y MARCA", () => {
    // El editor de D1 no deja guardar esto, pero el motor no puede confiar en
    // el editor: los datos también entran por migración y por SQL. Elegir en
    // silencio sería adivinar.
    const a = rule({ id: 1, categoryId: "montajes", percentBp: 1_000 });
    const b = rule({ id: 2, categoryId: "montajes", percentBp: 2_000 });

    const resolved = resolveRule([a, b], target, SOFIA);

    expect(resolved.rule?.id).toBe(2);
    expect(resolved.flag).toBe("regla-ambigua");
    expect(resolveRule([b, a], target, SOFIA).rule?.id).toBe(2);
  });

  it("dos reglas de especificidad distinta no son ambiguas aunque compartan fecha", () => {
    const resolved = resolveRule(
      [rule({ id: 1, categoryId: "montajes" }), rule({ id: 2, eaProviderId: SOFIA })],
      target,
      SOFIA,
    );

    expect(resolved.rule?.id).toBe(2);
    expect(resolved.flag).toBeNull();
  });
});

describe("vigencias", () => {
  const vigente = rule({ id: 1, validFrom: "2026-08-01", validTo: "2026-08-15" });

  it("valid_to es INCLUSIVO: la regla que termina el 15 aplica el 15 completo", () => {
    expect(resolveRule([vigente], line({ itemId: 1, serviceDate: "2026-08-15" }), SOFIA).rule?.id).toBe(1);
    expect(resolveRule([vigente], line({ itemId: 1, serviceDate: "2026-08-16" }), SOFIA).flag).toBe("sin-regla");
  });

  it("valid_from también es inclusivo", () => {
    expect(resolveRule([vigente], line({ itemId: 1, serviceDate: "2026-08-01" }), SOFIA).rule?.id).toBe(1);
    expect(resolveRule([vigente], line({ itemId: 1, serviceDate: "2026-07-31" }), SOFIA).flag).toBe("sin-regla");
  });

  it("valid_to nulo es vigente para siempre", () => {
    const abierta = rule({ id: 1, validFrom: "2020-01-01", validTo: null });
    expect(resolveRule([abierta], line({ itemId: 1, serviceDate: "2099-12-31" }), SOFIA).rule?.id).toBe(1);
  });

  it("rechaza fechas que no son de calendario", () => {
    expect(() => resolveRule([], line({ itemId: 1, serviceDate: "31/08/2026" }), SOFIA)).toThrow(
      CommissionError,
    );
    expect(() =>
      resolveRule([rule({ id: 1, validFrom: "ayer" })], line({ itemId: 1 }), SOFIA),
    ).toThrow(/vigencia inicial/);
    expect(() =>
      resolveRule([rule({ id: 1, validTo: "pronto" })], line({ itemId: 1 }), SOFIA),
    ).toThrow(/vigencia final/);
  });
});

describe("applies_to — principal, adicionales, ambos", () => {
  const principal = line({ itemId: 1, kind: "servicio" });
  const extra = line({ itemId: 2, kind: "adicional", categoryId: "extras", eaServiceId: null });

  it("una regla de principal no toca los adicionales", () => {
    const soloPrincipal = rule({ id: 1, appliesTo: "principal" });

    expect(resolveRule([soloPrincipal], principal, SOFIA).rule?.id).toBe(1);
    expect(resolveRule([soloPrincipal], extra, SOFIA).flag).toBe("sin-regla");
  });

  it("y al revés", () => {
    const soloExtras = rule({ id: 1, appliesTo: "adicionales" });

    expect(resolveRule([soloExtras], extra, SOFIA).rule?.id).toBe(1);
    expect(resolveRule([soloExtras], principal, SOFIA).flag).toBe("sin-regla");
  });

  it("`ambos` alcanza a los dos", () => {
    const ambos = rule({ id: 1, appliesTo: "ambos" });

    expect(resolveRule([ambos], principal, SOFIA).rule?.id).toBe(1);
    expect(resolveRule([ambos], extra, SOFIA).rule?.id).toBe(1);
  });

  it("un renglón manual queda en cero MARCADO, no metido a la fuerza en principal", () => {
    // No tiene servicio ni categoría, así que ninguna regla por servicio o por
    // categoría puede alcanzarlo, y `applies_to` no tiene un valor que lo
    // describa. Se marca para que se vea en revisión.
    const manual = line({ itemId: 3, kind: "manual", eaServiceId: null, categoryId: null });
    const resolved = resolveRule([rule({ id: 1 })], manual, SOFIA);

    expect(resolved.rule).toBeNull();
    expect(resolved.flag).toBe("renglon-manual");
  });
});

describe("applyRule — porcentaje y monto fijo", () => {
  it("porcentaje en puntos básicos, redondeado a pesos por renglón", () => {
    // 12,5 % es la razón de que las tasas sean bp y no un entero 0–100.
    expect(applyRule(rule({ id: 1, percentBp: 1_250 }), 115_000)).toEqual({
      amount: 14_375,
      rateBp: 1_250,
    });
  });

  it("el redondeo es por renglón, no al final del periodo", () => {
    // Tres renglones de 3.333 al 12,5 % dan 416,625 cada uno. Redondeando por
    // renglón: 417 × 3 = 1.251. Al final del periodo daría 1.250. La diferencia
    // importa porque `commission_entry` guarda una fila por renglón y la suma
    // de las filas tiene que ser el total de la liquidación.
    const porRenglon = [3_333, 3_333, 3_333].map(
      (base) => applyRule(rule({ id: 1, percentBp: 1_250 }), base).amount,
    );

    expect(porRenglon).toEqual([417, 417, 417]);
    expect(porRenglon.reduce((a, b) => a + b, 0)).toBe(1_251);
  });

  it("monto fijo paga una vez por renglón, cualquiera sea la cantidad", () => {
    // Un renglón de tres diseños es un renglón. Queda pendiente de confirmar
    // con la dueña si un fijo debería pagar por unidad.
    const fija = rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 5_000 });

    expect(applyRule(fija, 30_000)).toEqual({ amount: 5_000, rateBp: null });
    expect(applyRule(fija, 10_000)).toEqual({ amount: 5_000, rateBp: null });
  });

  it("un fijo mayor que la base NO se recorta", () => {
    // Es una regla mal configurada, y recortarla en silencio escondería el
    // error justo donde más caro sale. El simulador de D1 es donde eso se ve
    // antes de pagarse.
    const fija = rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 50_000 });

    expect(applyRule(fija, 10_000).amount).toBe(50_000);
  });

  it("una base negativa produce una comisión negativa", () => {
    // Es como se descuenta una corrección de la quincena siguiente.
    expect(applyRule(rule({ id: 1, percentBp: 1_000 }), -50_000).amount).toBe(-5_000);
  });

  it("una tasa de cero es una tasa, y paga cero SIN marcar", () => {
    // Cero por regla explícita y cero por falta de regla son cosas distintas.
    const resolved = resolveRule([rule({ id: 1, percentBp: 0 })], line({ itemId: 1 }), SOFIA);

    expect(resolved.flag).toBeNull();
    expect(applyRule(rule({ id: 1, percentBp: 0 }), 100_000).amount).toBe(0);
  });

  it("revienta con una regla incoherente en vez de pagar cualquier cosa", () => {
    expect(() => applyRule(rule({ id: 1, kind: "percent", percentBp: null }), 100)).toThrow(
      /percent_bp/,
    );
    expect(() => applyRule(rule({ id: 1, kind: "percent", percentBp: 1.5 }), 100)).toThrow(
      /percent_bp/,
    );
    expect(() =>
      applyRule(rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: null }), 100),
    ).toThrow(/fixed_amount/);
    expect(() =>
      applyRule(rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 1.5 }), 100),
    ).toThrow(/fixed_amount/);
    expect(() => applyRule(rule({ id: 1 }), 100.5)).toThrow(/base de comisión/);
  });
});

describe("computeCommissions", () => {
  it("sin ninguna regla vigente: cero MARCADO en cada renglón", () => {
    // Un cero silencioso es indistinguible de un cero correcto, y eso es una
    // liquidación mal pagada sin que nadie se entere.
    const results = computeCommissions(
      [{ line: line({ itemId: 1 }), assignments: solo(SOFIA) }],
      [],
    );

    expect(results).toEqual([
      {
        itemId: 1,
        eaProviderId: SOFIA,
        ruleId: null,
        baseAmount: 100_000,
        rateBp: null,
        amount: 0,
        flagged: true,
        flag: "sin-regla",
      },
    ]);
  });

  it("un periodo entero sin reglas no paga nada y deja todo marcado", () => {
    const inputs: CommissionInput[] = [1, 2, 3].map((itemId) => ({
      line: line({ itemId }),
      assignments: solo(SOFIA),
    }));

    const totals = totalsByProvider(computeCommissions(inputs, []));

    expect(totals).toEqual([
      { eaProviderId: SOFIA, base: 300_000, amount: 0, flaggedCount: 3 },
    ]);
  });

  it("reparte un combo entre dos técnicas y las partes suman exacto a la base", () => {
    // Un combo trabajado por dos personas se resuelve con el reparto, no
    // partiendo la cita — partirla duplicaría el evento de Google y la
    // notificación a la clienta.
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, categoryId: "combos", eaServiceId: 40, baseAmount: 95_001 }),
          assignments: [
            { eaProviderId: SOFIA, shareBp: 6_000 },
            { eaProviderId: DANIELA, shareBp: 4_000 },
          ],
        },
      ],
      [rule({ id: 1, percentBp: 1_000 })],
    );

    expect(results.map((r) => r.baseAmount)).toEqual([57_001, 38_000]);
    expect(results.reduce((sum, r) => sum + r.baseAmount, 0)).toBe(95_001);
    expect(results.map((r) => r.amount)).toEqual([5_700, 3_800]);
  });

  it("cada técnica resuelve SU propia regla sobre el mismo renglón", () => {
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, baseAmount: 100_000 }),
          assignments: [
            { eaProviderId: SOFIA, shareBp: 5_000 },
            { eaProviderId: DANIELA, shareBp: 5_000 },
          ],
        },
      ],
      [
        rule({ id: 1, eaProviderId: SOFIA, percentBp: 1_500 }),
        rule({ id: 2, eaProviderId: DANIELA, percentBp: 1_000 }),
      ],
    );

    expect(results.map((r) => [r.ruleId, r.amount])).toEqual([
      [1, 7_500],
      [2, 5_000],
    ]);
  });

  it("rechaza un reparto que no suma 10000 bp", () => {
    expect(() =>
      computeCommissions(
        [
          {
            line: line({ itemId: 1 }),
            assignments: [
              { eaProviderId: SOFIA, shareBp: 6_000 },
              { eaProviderId: DANIELA, shareBp: 3_000 },
            ],
          },
        ],
        [],
      ),
    ).toThrow(/tiene que sumar 10000/);
  });

  it("rechaza un renglón sin técnica asignada", () => {
    expect(() =>
      computeCommissions([{ line: line({ itemId: 1 }), assignments: [] }], []),
    ).toThrow(/sin técnica asignada/);
  });

  it("rechaza una base con centavos", () => {
    expect(() =>
      computeCommissions([{ line: line({ itemId: 1, baseAmount: 1.5 }), assignments: solo(SOFIA) }], []),
    ).toThrow(/base del renglón 1/);
  });

  it("una regla ambigua se aplica y llega marcada al resultado", () => {
    const results = computeCommissions(
      [{ line: line({ itemId: 1 }), assignments: solo(SOFIA) }],
      [rule({ id: 1, percentBp: 1_000 }), rule({ id: 2, percentBp: 2_000 })],
    );

    expect(results[0]).toMatchObject({ ruleId: 2, amount: 20_000, flagged: true, flag: "regla-ambigua" });
  });
});

describe("totalsByProvider", () => {
  it("suma por técnica y ordena por id", () => {
    const totals = totalsByProvider([
      { itemId: 1, eaProviderId: DANIELA, ruleId: 1, baseAmount: 100, rateBp: 1_000, amount: 10, flagged: false, flag: null },
      { itemId: 2, eaProviderId: SOFIA, ruleId: 1, baseAmount: 200, rateBp: 1_000, amount: 20, flagged: false, flag: null },
      { itemId: 3, eaProviderId: SOFIA, ruleId: null, baseAmount: 50, rateBp: null, amount: 0, flagged: true, flag: "sin-regla" },
    ]);

    expect(totals).toEqual([
      { eaProviderId: SOFIA, base: 250, amount: 20, flaggedCount: 1 },
      { eaProviderId: DANIELA, base: 100, amount: 10, flaggedCount: 0 },
    ]);
  });

  it("sin resultados devuelve una lista vacía", () => {
    expect(totalsByProvider([])).toEqual([]);
  });
});

describe("la base es el renglón REALIZADO, no el servicio agendado", () => {
  it("cita agendada como press-on, cerrada como forrado + 3 diseños", () => {
    // El caso que el plan pone como prueba explícita. El motor **no recibe** el
    // servicio agendado: la cuenta ya resolvió qué se hizo, y pasarle las dos
    // cosas le daría la oportunidad de elegir mal.
    //
    // Press-on son $100.000; forrado de acrílico, $85.000. Si el motor comisionara
    // sobre lo agendado, pagaría de más y sobre plata que nunca entró.
    const ticket = computeTicketTotals([
      { kind: "servicio", eaServiceId: 12, pricingId: "acrylic-overlay", qty: 1, unitPriceSnapshot: 85_000 },
      { kind: "adicional", pricingId: "design-per-nail", qty: 3, unitPriceSnapshot: 10_000 },
    ]);

    const rules = [
      rule({ id: 1, eaProviderId: SOFIA, categoryId: "forrados", appliesTo: "principal", percentBp: 1_500 }),
      rule({ id: 2, eaProviderId: SOFIA, categoryId: "extras", appliesTo: "adicionales", percentBp: 500 }),
      // Trampa: una regla generosa atada al servicio press-on. Si el motor
      // mirara lo agendado, ganaría ésta.
      rule({ id: 3, eaProviderId: SOFIA, eaServiceId: 5, percentBp: 5_000 }),
    ];

    const results = computeCommissions(
      [
        {
          line: line({
            itemId: 1,
            kind: "servicio",
            eaServiceId: 12,
            categoryId: "forrados",
            baseAmount: ticket.lines[0].netTotal,
          }),
          assignments: solo(SOFIA),
        },
        {
          line: line({
            itemId: 2,
            kind: "adicional",
            eaServiceId: null,
            categoryId: "extras",
            baseAmount: ticket.lines[1].netTotal,
          }),
          assignments: solo(SOFIA),
        },
      ],
      rules,
    );

    expect(results.map((r) => [r.ruleId, r.baseAmount, r.amount])).toEqual([
      [1, 85_000, 12_750],
      [2, 30_000, 1_500],
    ]);

    // Sobre lo agendado habría pagado 50 % de $100.000 = $50.000.
    expect(results.reduce((sum, r) => sum + r.amount, 0)).toBe(14_250);
  });

  it("el descuento del ticket baja la comisión de quien lo dio", () => {
    // Base = lo cobrado en ese renglón, con el descuento prorrateado. El
    // incentivo se alinea solo; sobre precio de lista lo pagaría entero el
    // estudio.
    const conDescuento = computeTicketTotals([
      { kind: "servicio", eaServiceId: 12, qty: 1, unitPriceSnapshot: 100_000 },
    ], 20_000);

    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, baseAmount: conDescuento.lines[0].netTotal }),
          assignments: solo(SOFIA),
        },
      ],
      [rule({ id: 1, percentBp: 1_500 })],
    );

    expect(results[0].baseAmount).toBe(80_000);
    expect(results[0].amount).toBe(12_000); // y no 15.000
  });
});

describe("fortnightFor — los cortes de la quincena", () => {
  it("1–15 y 16–fin de mes", () => {
    expect(fortnightFor("2026-08-01")).toEqual({ periodStart: "2026-08-01", periodEnd: "2026-08-15" });
    expect(fortnightFor("2026-08-15")).toEqual({ periodStart: "2026-08-01", periodEnd: "2026-08-15" });
    expect(fortnightFor("2026-08-16")).toEqual({ periodStart: "2026-08-16", periodEnd: "2026-08-31" });
    expect(fortnightFor("2026-08-31")).toEqual({ periodStart: "2026-08-16", periodEnd: "2026-08-31" });
  });

  it("meses de 30 días, febrero y años bisiestos", () => {
    expect(fortnightFor("2026-04-20").periodEnd).toBe("2026-04-30");
    expect(fortnightFor("2026-02-20").periodEnd).toBe("2026-02-28");
    expect(fortnightFor("2028-02-20").periodEnd).toBe("2028-02-29");
  });

  it("no depende de la zona del proceso", () => {
    // Se calcula en UTC a propósito: con la zona local, el último día del mes
    // se corre uno hacia atrás en cualquier zona al oeste de Greenwich.
    expect(fortnightFor("2026-12-31")).toEqual({ periodStart: "2026-12-16", periodEnd: "2026-12-31" });
    expect(fortnightFor("2026-01-01")).toEqual({ periodStart: "2026-01-01", periodEnd: "2026-01-15" });
  });

  it("rechaza fechas mal formadas o imposibles", () => {
    expect(() => fortnightFor("2026-8-1")).toThrow(CommissionError);
    expect(() => fortnightFor("2026-13-01")).toThrow(/fuera de rango/);
    expect(() => fortnightFor("2026-00-10")).toThrow(/fuera de rango/);
    expect(() => fortnightFor("2026-01-00")).toThrow(/fuera de rango/);
    expect(() => fortnightFor("2026-01-32")).toThrow(/fuera de rango/);
  });
});
