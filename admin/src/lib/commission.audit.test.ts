import { describe, expect, it } from "vitest";

import {
  applyRule,
  computeCommissions,
  fortnightFor,
  resolveRule,
  totalsByProvider,
  type CommissionRuleInput,
  type CommissionableLine,
} from "./commission";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 *
 * Todas las tasas son de fixture: las reales son una decisión pendiente de la
 * dueña. Lo que se ataca acá no son los números sino las reglas que el plan fija
 * y que la cobertura al 100 % de ramas no garantiza.
 */

const LINA = 7;
const SOFIA = 2;

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

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 2 — un `fixed` paga una vez por ASIGNACIÓN, no una vez por renglón.
 *
 * Contrato de B1 (`docs/WORK-PACKAGES.md`): "**Un `fixed` paga una vez por
 * renglón, no por unidad** — se sigue de 'se evalúa por renglón'". El test del
 * builder solo prueba el eje de la cantidad (`commission.test.ts:248`).
 *
 * El otro eje —el que el plan describe explícitamente en § Combos, "dos técnicas
 * trabajando un combo se resuelve con `allocation_hands_pct` más un provider
 * secundario"— no está cubierto, y ahí el fijo se paga completo dos veces.
 * `splitBase()` se toma el trabajo de partir la base con reparto exacto y
 * `applyRule()` la ignora por completo cuando la regla es `fixed`.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · un fijo paga UNA vez por renglón", () => {
  const fija = rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 5_000 });

  it("un renglón trabajado por dos técnicas sigue siendo un renglón", () => {
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, categoryId: "combos", baseAmount: 95_000 }),
          assignments: [
            { eaProviderId: LINA, shareBp: 5_000 },
            { eaProviderId: SOFIA, shareBp: 5_000 },
          ],
        },
      ],
      [fija],
    );

    // La base se parte (47.500 + 47.500 = 95.000) pero el fijo no: se paga
    // entero a cada una.
    expect(results.map((r) => r.baseAmount)).toEqual([47_500, 47_500]);
    expect(results.reduce((sum, r) => sum + r.amount, 0)).toBe(5_000);
  });

  it("y con tres asignaciones se paga tres veces", () => {
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, baseAmount: 90_000 }),
          assignments: [
            { eaProviderId: 1, shareBp: 4_000 },
            { eaProviderId: 2, shareBp: 3_000 },
            { eaProviderId: 3, shareBp: 3_000 },
          ],
        },
      ],
      [fija],
    );

    expect(results.reduce((sum, r) => sum + r.amount, 0)).toBe(5_000);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 3 — con una regla `fixed`, una corrección PAGA otra vez en vez de
 * descontar.
 *
 * El mecanismo de corrección que fija el plan es un renglón nuevo que resta
 * (§ Independencia con rastro: "genera un **ajuste** — renglón nuevo con su
 * motivo"), y el propio builder lo dejó por escrito para el caso `percent`:
 * "una base negativa produce una comisión negativa. Es como se descuenta una
 * corrección de la quincena siguiente" (`commission.test.ts:266`).
 *
 * Con `kind: "fixed"` el signo de la base no se mira. Cobrar 50.000 y corregirlo
 * a cero deja la base de la quincena en 0 y la comisión en **+10.000**: la
 * corrección duplica el pago en vez de cancelarlo.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · una corrección cancela el cobro que corrige", () => {
  const fija = rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 5_000 });

  it("con un fijo, el renglón de ajuste no descuenta nada: vuelve a pagar", () => {
    expect(applyRule(fija, -50_000).amount).toBe(-5_000);
  });

  it("cobro + su ajuste dejan la quincena en cero, no al doble", () => {
    const results = computeCommissions(
      [
        { line: line({ itemId: 1, baseAmount: 50_000 }), assignments: solo(LINA) },
        { line: line({ itemId: 2, baseAmount: -50_000 }), assignments: solo(LINA) },
      ],
      [fija],
    );

    const [total] = totalsByProvider(results);

    expect(total.base).toBe(0);
    expect(total.amount).toBe(0);
  });
});

// ── Superficie que sí resiste ───────────────────────────────────────────────

describe("AUDIT · precedencia, re-derivada desde el plan", () => {
  const target = line({ itemId: 1, eaServiceId: 6, categoryId: "montajes" });

  const escalera: [string, Partial<CommissionRuleInput>][] = [
    ["global", {}],
    ["category", { categoryId: "montajes" }],
    ["service", { eaServiceId: 6 }],
    ["provider", { eaProviderId: LINA }],
    ["provider+category", { eaProviderId: LINA, categoryId: "montajes" }],
    ["provider+service", { eaProviderId: LINA, eaServiceId: 6 }],
  ];

  it("gana siempre el escalón más alto presente, para todo subconjunto", () => {
    // 2^6 subconjuntos: cualquier combinación de reglas aplicables tiene que
    // resolver al escalón más específico que esté en el conjunto.
    for (let mask = 1; mask < 1 << escalera.length; mask += 1) {
      const rules: CommissionRuleInput[] = [];
      let esperado = -1;

      for (const [index, [, shape]] of escalera.entries()) {
        if ((mask & (1 << index)) === 0) continue;
        rules.push(rule({ id: index + 1, ...shape }));
        esperado = index + 1;
      }

      // Se barajan para probar que el resultado no depende del orden de entrada.
      const barajadas = [...rules].reverse();

      expect(resolveRule(barajadas, target, LINA).rule?.id).toBe(esperado);
      expect(resolveRule(rules, target, LINA).rule?.id).toBe(esperado);
    }
  });

  it("los bordes de vigencia son inclusivos en los dos extremos, día por día", () => {
    const vigente = rule({ id: 1, validFrom: "2026-08-10", validTo: "2026-08-20" });

    for (let day = 8; day <= 22; day += 1) {
      const fecha = `2026-08-${String(day).padStart(2, "0")}`;
      const dentro = day >= 10 && day <= 20;

      expect(resolveRule([vigente], line({ itemId: 1, serviceDate: fecha }), LINA).rule).toEqual(
        dentro ? vigente : null,
      );
    }
  });
});

describe("AUDIT · la marca sobrevive a todos los caminos", () => {
  it("`flagged` es siempre `flag !== null`, sobre todo el producto de entradas", () => {
    const conjuntos: CommissionRuleInput[][] = [
      [],
      [rule({ id: 1 })],
      [rule({ id: 1 }), rule({ id: 2 })], // empate total ⇒ ambigua
      [rule({ id: 1 }), rule({ id: 2, validFrom: "2026-02-01" })],
      [rule({ id: 1, appliesTo: "principal" })],
      [rule({ id: 1, appliesTo: "adicionales" })],
      [rule({ id: 1, validTo: "2026-01-31" })], // vencida
    ];

    for (const rules of conjuntos) {
      for (const kind of ["servicio", "adicional", "manual"] as const) {
        for (const base of [-50_000, 0, 33_333]) {
          const results = computeCommissions(
            [{ line: line({ itemId: 1, kind, baseAmount: base }), assignments: solo(LINA) }],
            rules,
          );

          for (const result of results) {
            expect(result.flagged).toBe(result.flag !== null);
            // Cero sin regla nunca puede salir sin marca.
            if (result.ruleId === null) expect(result.flag).not.toBeNull();
          }
        }
      }
    }
  });

  it("el empate total gana por id mayor Y llega marcado también con dos técnicas", () => {
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1 }),
          assignments: [
            { eaProviderId: LINA, shareBp: 5_000 },
            { eaProviderId: SOFIA, shareBp: 5_000 },
          ],
        },
      ],
      [rule({ id: 41 }), rule({ id: 42 })],
    );

    expect(results.every((r) => r.ruleId === 42)).toBe(true);
    expect(results.every((r) => r.flag === "regla-ambigua")).toBe(true);
    expect(totalsByProvider(results).every((t) => t.flaggedCount === 1)).toBe(true);
  });
});

describe("AUDIT · la comisión no se recorta a la base", () => {
  it("un fijo mal configurado puede dejar al estudio pagando más de lo que cobró", () => {
    // Documentado y aceptado: recortarlo escondería la regla mal configurada.
    // Se fija acá para que quede explícito cuánto puede doler.
    const results = computeCommissions(
      [
        {
          line: line({ itemId: 1, baseAmount: 10_000 }),
          assignments: solo(LINA),
        },
      ],
      [rule({ id: 1, kind: "fixed", percentBp: null, fixedAmount: 50_000 })],
    );

    const [total] = totalsByProvider(results);
    expect(total.base).toBe(10_000);
    expect(total.amount).toBe(50_000);
    // Y sin marca: el motor no considera esto un caso que necesite ojos.
    expect(total.flaggedCount).toBe(0);
  });

  it("una liquidación puede salir negativa cuando el periodo es solo correcciones", () => {
    const results = computeCommissions(
      [{ line: line({ itemId: 1, baseAmount: -80_000 }), assignments: solo(LINA) }],
      [rule({ id: 1, percentBp: 1_500 })],
    );

    expect(totalsByProvider(results)[0].amount).toBe(-12_000);
  });
});

describe("AUDIT · fortnightFor", () => {
  it("acepta un 30 de febrero y le asigna quincena en vez de rechazarlo", () => {
    // El chequeo es `day > 31`, no calendario. No mueve plata por sí solo —
    // ninguna cita puede tener esa fecha— pero deja la puerta abierta a que un
    // periodo se arme sobre una fecha que no existe.
    expect(fortnightFor("2026-02-30")).toEqual({
      periodStart: "2026-02-16",
      periodEnd: "2026-02-28",
    });
  });

  it("todos los meses de un año bisiesto y de uno normal cierran en el día real", () => {
    for (const year of [2024, 2026]) {
      for (let month = 1; month <= 12; month += 1) {
        const mm = String(month).padStart(2, "0");
        const last = new Date(Date.UTC(year, month, 0)).getUTCDate();

        expect(fortnightFor(`${year}-${mm}-16`).periodEnd).toBe(
          `${year}-${mm}-${String(last).padStart(2, "0")}`,
        );
        expect(fortnightFor(`${year}-${mm}-15`)).toEqual({
          periodStart: `${year}-${mm}-01`,
          periodEnd: `${year}-${mm}-15`,
        });
      }
    }
  });
});
