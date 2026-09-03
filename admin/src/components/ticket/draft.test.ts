import { describe, expect, it } from "vitest";

import type { CatalogService, TicketCatalog } from "./catalog";
import {
  DRAFT_VERSION,
  appendNoteChip,
  bumpExtra,
  draftFromFinance,
  draftToItems,
  emptyDraft,
  isDirty,
  priceDraft,
  setExtraQty,
  type TicketDraft,
  type TicketPricing,
} from "./draft";

/**
 * El caso del plan, entero: se agendó **press-on** y la clienta terminó con un
 * **forrado en acrílico más tres uñas con diseño**. Es el mismo caso que el
 * golden test de B1 y el mismo que pide la Definition of Done de este paquete.
 *
 * Los números salen de `src/data/pricing.ts`: press-on 100.000, forrado en
 * acrílico 85.000, diseño por uña 10.000.
 */

const PRESS_ON = 1;
const FORRADO = 2;
const DISENO = 10;
const RETIRO = 11;

function service(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Montajes",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    service({ eaServiceId: PRESS_ON, name: "Press-on", listPrice: 100_000, pricingId: "press-on" }),
    service({
      eaServiceId: FORRADO,
      name: "Forrado en acrílico",
      listPrice: 85_000,
      categoryId: 2,
      categoryName: "Forrados",
      pricingId: "acrylic-overlay",
    }),
    service({
      eaServiceId: DISENO,
      name: "Diseño por uña",
      listPrice: 10_000,
      categoryId: 9,
      categoryName: "Extras",
      pricingId: "design-per-nail",
      isExtra: true,
    }),
    service({
      eaServiceId: RETIRO,
      name: "Retiro de sistema",
      listPrice: 20_000,
      categoryId: 9,
      categoryName: "Extras",
      pricingId: "system-removal",
      isExtra: true,
    }),
    service({
      eaServiceId: 99,
      name: "Servicio sin precio en EA",
      listPrice: null,
      pricingId: null,
    }),
  ],
};

/** La cita venía agendada como press-on, con su precio congelado. */
const AGENDADO: TicketPricing = { bookedServiceId: PRESS_ON, bookedSnapshot: 100_000 };

function draft(over: Partial<TicketDraft> = {}): TicketDraft {
  return { ...emptyDraft(77, PRESS_ON, 1_000), ...over };
}

describe("emptyDraft", () => {
  it("viene con el servicio agendado ya elegido — es el paso 1 del flujo", () => {
    const d = emptyDraft(77, PRESS_ON, 1_000);
    expect(d.performedServiceId).toBe(PRESS_ON);
    expect(d.version).toBe(DRAFT_VERSION);
    expect(d.extras).toEqual({});
    expect(d.tip).toBe(0);
    expect(d.updatedAt).toBe(1_000);
  });

  it("acepta una cita de EA sin servicio", () => {
    expect(emptyDraft(77, null).performedServiceId).toBeNull();
  });
});

describe("setExtraQty / bumpExtra", () => {
  it("el cero borra la clave en vez de guardarse", () => {
    const con = setExtraQty(draft(), DISENO, 3, 2_000);
    expect(con.extras).toEqual({ "10": 3 });
    expect(setExtraQty(con, DISENO, 0, 3_000).extras).toEqual({});
    expect(setExtraQty(con, DISENO, -5, 3_000).extras).toEqual({});
  });

  it("suma y resta desde el contador actual", () => {
    let d = draft();
    d = bumpExtra(d, DISENO, 1);
    d = bumpExtra(d, DISENO, 1);
    d = bumpExtra(d, DISENO, 1);
    expect(d.extras).toEqual({ "10": 3 });
    d = bumpExtra(d, DISENO, -1);
    expect(d.extras).toEqual({ "10": 2 });
  });

  it("trunca una cantidad fraccionaria antes de que llegue al motor", () => {
    expect(setExtraQty(draft(), DISENO, 2.7).extras).toEqual({ "10": 2 });
  });
});

describe("isDirty", () => {
  const base = draft();

  it("un borrador igual no está sucio, aunque cambie la hora", () => {
    expect(isDirty({ ...base, updatedAt: 99_999 }, base)).toBe(false);
  });

  it.each([
    ["servicio", { performedServiceId: FORRADO }],
    ["adicionales", { extras: { "10": 1 } }],
    ["manual", { manual: { note: "x", amount: 0 } }],
    ["total", { totalOverride: 1 }],
    ["motivo", { varianceReasonCode: "cortesia" as const }],
    ["detalle", { varianceReason: "porque sí" }],
    ["observaciones", { notes: "se rompió una" }],
    ["método", { paymentMethod: "efectivo" as const }],
    ["propina", { tip: 5_000 }],
  ])("detecta un cambio en %s", (_que, patch) => {
    expect(isDirty({ ...base, ...patch }, base)).toBe(true);
  });
});

describe("draftToItems", () => {
  it("usa el precio congelado cuando lo realizado es lo agendado", () => {
    const { items, flags } = draftToItems(draft(), CATALOGO, {
      bookedServiceId: PRESS_ON,
      // EA subió el precio después de agendar. El congelado manda.
      bookedSnapshot: 90_000,
    });
    expect(items).toHaveLength(1);
    expect(items[0].unitPriceSnapshot).toBe(90_000);
    expect(flags).toEqual([]);
  });

  it("usa el precio de lista de hoy cuando el servicio cambió", () => {
    const { items } = draftToItems(
      draft({ performedServiceId: FORRADO }),
      CATALOGO,
      AGENDADO,
    );
    expect(items[0].unitPriceSnapshot).toBe(85_000);
  });

  it("cae al precio de lista si la cita nunca congeló nada", () => {
    const { items } = draftToItems(draft(), CATALOGO, {
      bookedServiceId: PRESS_ON,
      bookedSnapshot: null,
    });
    expect(items[0].unitPriceSnapshot).toBe(100_000);
  });

  it("marca —y no inventa— el servicio sin precio en EA", () => {
    const { items, flags } = draftToItems(
      draft({ performedServiceId: 99 }),
      CATALOGO,
      AGENDADO,
    );
    expect(items[0].unitPriceSnapshot).toBe(0);
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe("Servicio sin precio en EA");
  });

  it("no arma renglón de servicio si no se eligió ninguno", () => {
    const { items } = draftToItems(
      draft({ performedServiceId: null, extras: { "10": 1 } }),
      CATALOGO,
      AGENDADO,
    );
    expect(items.map((i) => i.kind)).toEqual(["adicional"]);
  });

  it("arma los adicionales en el orden del catálogo, con su cantidad", () => {
    const { items } = draftToItems(
      draft({ extras: { "11": 1, "10": 3 } }),
      CATALOGO,
      AGENDADO,
    );
    expect(items.slice(1).map((i) => [i.eaServiceId, i.qty])).toEqual([
      [DISENO, 3],
      [RETIRO, 1],
    ]);
  });

  it("marca un adicional sin precio en EA", () => {
    const catalogo: TicketCatalog = {
      services: [service({ eaServiceId: 50, name: "Nuevo", isExtra: true, listPrice: null })],
    };
    const { items, flags } = draftToItems(
      draft({ performedServiceId: null, extras: { "50": 2 } }),
      catalogo,
      AGENDADO,
    );
    expect(items[0].unitPriceSnapshot).toBe(0);
    expect(flags[0].message).toContain("adicional");
  });

  it("reporta un adicional que desapareció del catálogo en vez de cobrarlo en cero", () => {
    const { items, flags } = draftToItems(
      draft({ extras: { "4242": 2 } }),
      CATALOGO,
      AGENDADO,
    );
    expect(items.map((i) => i.kind)).toEqual(["servicio"]);
    expect(flags).toHaveLength(1);
    expect(flags[0].label).toBe("Adicional #4242");
  });

  it("ignora una cantidad no positiva que quedó en el objeto", () => {
    const { items, flags } = draftToItems(
      { ...draft(), extras: { "10": 0, "4242": 0 } },
      CATALOGO,
      AGENDADO,
    );
    expect(items).toHaveLength(1);
    expect(flags).toEqual([]);
  });

  it("pone el renglón manual al final, con su nota", () => {
    const { items } = draftToItems(
      draft({ manual: { note: "Retoque de garantía", amount: 0 } }),
      CATALOGO,
      AGENDADO,
    );
    expect(items.at(-1)).toMatchObject({
      kind: "manual",
      qty: 1,
      unitPriceSnapshot: 0,
      note: "Retoque de garantía",
    });
  });
});

describe("priceDraft — el caso completo del plan", () => {
  const cerrado = draft({ performedServiceId: FORRADO, extras: { "10": 3 } });

  it("forrado + 3 diseños suma 115.000", () => {
    const r = priceDraft(cerrado, CATALOGO, AGENDADO);
    expect(r.subtotal).toBe(115_000);
    expect(r.totals?.amountCharged).toBe(115_000);
    expect(r.errors).toEqual([]);
  });

  it("con total escrito a mano el descuento se deriva y se prorratea exacto", () => {
    const r = priceDraft(
      { ...cerrado, totalOverride: 100_000, varianceReasonCode: "cortesia" },
      CATALOGO,
      AGENDADO,
    );
    expect(r.totals?.discount).toBe(15_000);
    expect(r.totals?.amountCharged).toBe(100_000);
    const repartido = r.totals?.lines.reduce((s, l) => s + l.discountShare, 0);
    expect(repartido).toBe(15_000);
    expect(r.errors).toEqual([]);
  });

  it("un descuento sin motivo no deja guardar, pero el total se sigue viendo", () => {
    const r = priceDraft({ ...cerrado, totalOverride: 100_000 }, CATALOGO, AGENDADO);
    expect(r.totals?.amountCharged).toBe(100_000);
    expect(r.errors.join(" ")).toContain("motivo");
  });

  it("escribir más que el subtotal se rechaza y el total vuelve al calculado", () => {
    const r = priceDraft({ ...cerrado, totalOverride: 200_000 }, CATALOGO, AGENDADO);
    expect(r.errors.join(" ")).toContain("supera el subtotal");
    expect(r.totals?.amountCharged).toBe(115_000);
  });

  it("una cuenta sin renglones no es una cuenta de cero", () => {
    const r = priceDraft(
      draft({ performedServiceId: null }),
      CATALOGO,
      AGENDADO,
    );
    expect(r.totals).toBeNull();
    expect(r.subtotal).toBeNull();
    expect(r.errors).toHaveLength(1);
  });

  it("un renglón manual sin nota bloquea el guardado con el mensaje del motor", () => {
    const r = priceDraft(
      draft({ manual: { note: "   ", amount: 5_000 } }),
      CATALOGO,
      AGENDADO,
    );
    expect(r.errors.join(" ")).toContain("nota");
  });

  it("la propina viaja aparte del total y del descuento", () => {
    const r = priceDraft({ ...cerrado, tip: 10_000 }, CATALOGO, AGENDADO);
    expect(r.totals?.tip).toBe(10_000);
    expect(r.totals?.amountCharged).toBe(115_000);
    expect(r.totals?.amountPaid).toBe(125_000);
  });

  it("una propina negativa se trata como cero en vez de reventar la hoja", () => {
    const r = priceDraft({ ...cerrado, tip: -5_000 }, CATALOGO, AGENDADO);
    expect(r.totals?.tip).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it("el retoque de garantía: renglón manual en cero, con nota, y no cobra nada", () => {
    const r = priceDraft(
      draft({
        performedServiceId: null,
        manual: { note: "Se repuso una uña", amount: 0 },
      }),
      CATALOGO,
      AGENDADO,
    );
    expect(r.totals?.amountCharged).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

describe("draftFromFinance", () => {
  it("reconstruye lo guardado para poder corregirlo", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: FORRADO,
      discount: 15_000,
      tip: 5_000,
      amountCharged: 100_000,
      paymentMethod: "efectivo",
      serviceNotes: "cambió de servicio",
      varianceReasonCode: "cambio_servicio",
      varianceReason: "pidió forrado",
      items: [
        { kind: "servicio", eaServiceId: FORRADO, qty: 1, unitPrice: 85_000, note: null },
        { kind: "adicional", eaServiceId: DISENO, qty: 3, unitPrice: 10_000, note: null },
      ],
    });

    expect(d.performedServiceId).toBe(FORRADO);
    expect(d.extras).toEqual({ "10": 3 });
    // Con descuento guardado, el total vuelve editable con lo que se cobró: si
    // no, reabrir y guardar le devolvería el precio de lista.
    expect(d.totalOverride).toBe(100_000);
    expect(d.varianceReasonCode).toBe("cambio_servicio");
    expect(d.tip).toBe(5_000);
    expect(d.notes).toBe("cambió de servicio");
  });

  it("sin descuento no fija un total escrito a mano", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: PRESS_ON,
      discount: 0,
      tip: 0,
      amountCharged: 100_000,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      items: [{ kind: "servicio", eaServiceId: PRESS_ON, qty: 1, unitPrice: 100_000, note: null }],
    });
    expect(d.totalOverride).toBeNull();
  });

  it("cae al servicio agendado si la fila no dice cuál se realizó", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: null,
      discount: 0,
      tip: 0,
      amountCharged: null,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      items: [],
    });
    expect(d.performedServiceId).toBe(PRESS_ON);
    expect(d.extras).toEqual({});
    expect(d.manual).toBeNull();
  });

  it("recupera el renglón manual y se queda con el primero", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: PRESS_ON,
      discount: 0,
      tip: 0,
      amountCharged: 0,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      items: [
        { kind: "manual", eaServiceId: null, qty: 1, unitPrice: 0, note: "garantía" },
        { kind: "manual", eaServiceId: null, qty: 1, unitPrice: 3_000, note: "otro" },
      ],
    });
    expect(d.manual).toEqual({ note: "garantía", amount: 0 });
  });

  it("suma dos renglones del mismo adicional e ignora los que no traen id", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: PRESS_ON,
      discount: 0,
      tip: 0,
      amountCharged: 0,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      items: [
        { kind: "adicional", eaServiceId: DISENO, qty: 2, unitPrice: 10_000, note: null },
        { kind: "adicional", eaServiceId: DISENO, qty: 1, unitPrice: 10_000, note: null },
        { kind: "adicional", eaServiceId: null, qty: 1, unitPrice: 10_000, note: null },
      ],
    });
    expect(d.extras).toEqual({ "10": 3 });
  });

  it("un renglón manual sin nota vuelve como cadena vacía, no como null", () => {
    const d = draftFromFinance(77, PRESS_ON, {
      performedServiceId: PRESS_ON,
      discount: 0,
      tip: 0,
      amountCharged: 0,
      paymentMethod: null,
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      items: [{ kind: "manual", eaServiceId: null, qty: 1, unitPrice: 0, note: null }],
    });
    expect(d.manual).toEqual({ note: "", amount: 0 });
  });
});

describe("appendNoteChip", () => {
  it("sobre un campo vacío deja el chip solo", () => {
    expect(appendNoteChip("", "llegó tarde")).toBe("llegó tarde");
    expect(appendNoteChip("   ", "llegó tarde")).toBe("llegó tarde");
  });

  it("encadena con coma y sin puntuación duplicada", () => {
    expect(appendNoteChip("se rompió una.", "llegó tarde")).toBe("se rompió una, llegó tarde");
  });

  it("no repite un chip que ya está", () => {
    expect(appendNoteChip("Llegó Tarde", "llegó tarde")).toBe("Llegó Tarde");
  });
});
