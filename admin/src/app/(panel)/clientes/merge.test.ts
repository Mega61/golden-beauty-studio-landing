import { describe, expect, it } from "vitest";

import type { Customer } from "@/lib/ea";

import { describeMerge, planMerge } from "./merge";

/**
 * Una fila de EA.
 *
 * Los `??` de los campos que estos tests manipulan están escritos con `in` y no
 * con `??` a propósito: `phone: null` explícito tiene que quedar en `null`, y un
 * `patch.phone ?? "+57…"` lo convertiría en el valor por defecto — que es
 * justamente el caso que se está probando.
 */
function customer(patch: Partial<Customer> & { id: number }): Customer {
  return {
    id: patch.id,
    firstName: "firstName" in patch ? patch.firstName! : "Ana",
    lastName: "lastName" in patch ? patch.lastName! : "Ríos",
    email: "email" in patch ? patch.email! : null,
    phone: "phone" in patch ? patch.phone! : "+573001234567",
    address: null,
    city: null,
    zip: null,
    timezone: null,
    language: null,
    customField1: null,
    customField2: null,
    customField3: null,
    customField4: null,
    customField5: null,
    ldapDn: null,
    notes: "notes" in patch ? patch.notes! : null,
  };
}

describe("planMerge", () => {
  it("sobrevive el id más bajo", () => {
    // El más viejo es el más probable de estar referenciado en algo que este
    // panel no ve: un evento de Google de hace meses, un enlace guardado.
    const plan = planMerge([customer({ id: 12 }), customer({ id: 4 }), customer({ id: 9 })]);

    expect(plan).toMatchObject({ survivor: { id: 4 } });
    if ("blocker" in plan) throw new Error("no debería bloquear");
    expect(plan.losers.map((l) => l.id)).toEqual([9, 12]);
  });

  it("el resultado no depende del orden en que llegaron", () => {
    // Dos corridas tienen que elegir lo mismo, o la confirmación que alguien
    // leyó no describe lo que se va a ejecutar.
    const filas = [customer({ id: 12 }), customer({ id: 4 })];
    const a = planMerge(filas);
    const b = planMerge([...filas].reverse());

    expect(a).toEqual(b);
  });

  it("le copia a la superviviente el correo que solo tenía la perdedora", () => {
    // Sin esto, fusionar perdería el correo para siempre — y el borrado es
    // irreversible.
    const plan = planMerge([
      customer({ id: 4, email: null }),
      customer({ id: 9, email: "ana@gmail.com" }),
    ]);

    expect(plan).toMatchObject({ enrich: { email: "ana@gmail.com" } });
  });

  it("no le pisa a la superviviente lo que ya tenía", () => {
    const plan = planMerge([
      customer({ id: 4, email: "vieja@gmail.com" }),
      customer({ id: 9, email: "nueva@gmail.com" }),
    ]);

    if ("blocker" in plan) throw new Error("no debería bloquear");
    expect(plan.enrich.email).toBeUndefined();
  });

  it("copia el teléfono cuando la superviviente no lo tiene", () => {
    // Pasa de verdad: una fila vieja creada por el flujo público antes de que
    // pidiera el número puede ser la del id más bajo.
    const plan = planMerge([
      customer({ id: 4, phone: null }),
      customer({ id: 9, phone: "+573001234567" }),
    ]);

    expect(plan).toMatchObject({ enrich: { phone: "+573001234567" } });
  });

  it("copia varios campos de varias perdedoras distintas", () => {
    const plan = planMerge([
      customer({ id: 4, email: null, notes: null }),
      customer({ id: 9, email: "ana@gmail.com", notes: null }),
      customer({ id: 12, email: null, notes: "Alérgica al acrílico" }),
    ]);

    expect(plan).toMatchObject({
      enrich: { email: "ana@gmail.com", notes: "Alérgica al acrílico" },
    });
  });

  it("gana el primer valor no vacío en orden de id, no el más largo", () => {
    // Cualquier regla más lista es una regla que hay que explicar. Lo que
    // importa es que ningún dato desaparezca, no cuál gana.
    const plan = planMerge([
      customer({ id: 4, notes: null }),
      customer({ id: 9, notes: "corto" }),
      customer({ id: 12, notes: "una nota mucho más larga" }),
    ]);

    expect(plan).toMatchObject({ enrich: { notes: "corto" } });
  });

  it("un campo en blanco cuenta como vacío", () => {
    const plan = planMerge([
      customer({ id: 4, email: "   " }),
      customer({ id: 9, email: "ana@gmail.com" }),
    ]);

    expect(plan).toMatchObject({ enrich: { email: "ana@gmail.com" } });
  });

  it("no hay nada que fusionar con una sola fila", () => {
    expect(planMerge([customer({ id: 4 })])).toEqual({ blocker: "una-sola" });
  });

  it("ni con ninguna", () => {
    expect(planMerge([])).toEqual({ blocker: "sin-filas" });
  });
});

describe("describeMerge", () => {
  it("dice quién se queda, quién se borra y que las citas se mueven antes", () => {
    const plan = planMerge([customer({ id: 4 }), customer({ id: 9 })]);
    if ("blocker" in plan) throw new Error("no debería bloquear");

    const texto = describeMerge(plan);

    expect(texto).toContain("Ana Ríos");
    expect(texto).toContain("#4");
    expect(texto).toContain("#9");
    expect(texto).toContain("se mueven antes");
  });

  it("nombra los campos que se copian", () => {
    const plan = planMerge([
      customer({ id: 4, email: null }),
      customer({ id: 9, email: "ana@gmail.com" }),
    ]);
    if ("blocker" in plan) throw new Error("no debería bloquear");

    expect(describeMerge(plan)).toContain("email");
  });

  it("usa el id cuando la fila no tiene nombre", () => {
    const plan = planMerge([
      customer({ id: 4, firstName: null, lastName: null }),
      customer({ id: 9 }),
    ]);
    if ("blocker" in plan) throw new Error("no debería bloquear");

    expect(describeMerge(plan)).toContain("#4");
  });
});
