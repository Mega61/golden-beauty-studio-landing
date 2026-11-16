import { describe, expect, it } from "vitest";

import { isPlausiblePhone } from "./booking";
import {
  cleanRef,
  cleanText,
  giftOrderErrors,
  parseOrderResult,
  parseTiers,
  paymentLines,
  tierKey,
  whatsappSendLink,
} from "./gift";
import { FALLBACK_GIFT_TIERS, isFallbackTier } from "@/data/gift-tiers";

const tier = { id: "t1", name: "Detalle", amountCop: 50000, description: "Semi manos", validityDays: 365 };

describe("parseTiers", () => {
  it("acepta la lista sola, { tiers } y el sobre { ok, data } de Stampee", () => {
    expect(parseTiers([tier])).toEqual([tier]);
    expect(parseTiers({ tiers: [tier] })).toEqual([tier]);
    expect(parseTiers({ ok: true, data: [tier] })).toEqual([tier]);
    expect(parseTiers({ ok: true, data: { tiers: [tier] } })).toEqual([tier]);
  });

  it("descarta lo que no se puede vender en vez de pintar una tarjeta de $0", () => {
    const out = parseTiers([
      tier,
      { ...tier, id: "" },
      { ...tier, id: "t2", amountCop: 0 },
      { ...tier, id: "t3", amountCop: "100000" },
      { ...tier, id: "t4", amountCop: 12.5 },
      null,
      "x",
    ]);
    expect(out.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("sin vigencia, vale un año", () => {
    expect(parseTiers([{ id: "a", name: "A", amountCop: 1 }])[0]).toMatchObject({ validityDays: 365, description: "" });
  });

  it("basura → lista vacía", () => {
    expect(parseTiers(null)).toEqual([]);
    expect(parseTiers({ error: "x" })).toEqual([]);
  });
});

describe("parseOrderResult", () => {
  const ok = { code: "TR-AB12-CD34", amountCop: 100000, tierName: "Consentida", publicUrl: "https://stampee.app/gbs/regalo/u1" };

  it("lee la respuesta del panel, con o sin sobre", () => {
    expect(parseOrderResult(ok)).toEqual(ok);
    expect(parseOrderResult({ ok: true, data: ok })).toEqual(ok);
  });

  it("sin código o sin link http no hay pedido que mostrar", () => {
    expect(parseOrderResult({ ...ok, code: "" })).toBeNull();
    expect(parseOrderResult({ ...ok, publicUrl: "javascript:alert(1)" })).toBeNull();
    expect(parseOrderResult(null)).toBeNull();
  });
});

describe("giftOrderErrors", () => {
  const good = { tierId: "t1", buyerName: "Laura", buyerPhone: "300 123 4567", recipientName: "", message: "" };

  it("un pedido completo pasa; el destinatario y el mensaje son opcionales", () => {
    expect(giftOrderErrors(good, isPlausiblePhone)).toEqual([]);
  });

  it("marca cada campo malo", () => {
    expect(
      giftOrderErrors(
        { tierId: "", buyerName: "L", buyerPhone: "123", recipientName: "A", message: "x".repeat(141) },
        isPlausiblePhone,
      ),
    ).toEqual(["tierId", "buyerName", "buyerPhone", "recipientName", "message"]);
  });

  it("el mensaje admite justo 140", () => {
    expect(giftOrderErrors({ ...good, message: "x".repeat(140) }, isPlausiblePhone)).toEqual([]);
  });
});

describe("whatsappSendLink", () => {
  it("usa api.whatsapp.com/send, nunca wa.me, y antepone 57 a un celular de 10 dígitos", () => {
    const url = whatsappSendLink("300 123 4567", "Hola Golden ✨ Quiero pagar mi tarjeta regalo TR-AB12-CD34");
    expect(url.startsWith("https://api.whatsapp.com/send?phone=573001234567&text=")).toBe(true);
    expect(url).not.toContain("wa.me");
    expect(decodeURIComponent(url.split("text=")[1])).toBe("Hola Golden ✨ Quiero pagar mi tarjeta regalo TR-AB12-CD34");
  });

  it("deja el número quieto si ya trae el indicativo", () => {
    expect(whatsappSendLink("573001234567", "x")).toContain("phone=573001234567&");
  });
});

describe("textos de WhatsApp del diccionario", () => {
  it("nunca llevan precio", async () => {
    for (const lang of ["es", "en"] as const) {
      const dict = (await import(`../app/[lang]/dictionaries/${lang}.json`)).default;
      const texts = [dict.regalar.success.whatsappText, dict.regalar.form.fallbackText];
      for (const text of texts) {
        expect(text).not.toMatch(/\$|\d{2,}|COP|amount|monto|valor/i);
      }
    }
  });
});

describe("ref, texto y tier", () => {
  it("cleanRef solo deja pasar un slug corto", () => {
    expect(cleanRef("adviento")).toBe("adviento");
    expect(cleanRef(" IG-Story ")).toBe("ig-story");
    expect(cleanRef(["adviento", "x"])).toBe("adviento");
    expect(cleanRef("<script>")).toBeNull();
    expect(cleanRef("a".repeat(41))).toBeNull();
    expect(cleanRef(undefined)).toBeNull();
  });

  it("cleanText junta espacios y corta", () => {
    expect(cleanText("  Feliz\n\nNavidad  ", 140)).toBe("Feliz Navidad");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText(42, 10)).toBe("");
  });

  it("tierKey normaliza el nombre de Stampee", () => {
    expect(tierKey("Consentida")).toBe("consentida");
    expect(tierKey(" Golden ✨ ")).toBe("golden");
    expect(tierKey("Edición Señora")).toBe("edicion-senora");
  });

  it("paymentLines parte por \\n literal, salto real o ' | '", () => {
    expect(paymentLines("Banco X\\nCuenta 1 | Titular Y")).toEqual(["Banco X", "Cuenta 1", "Titular Y"]);
    expect(paymentLines("  ")).toBeNull();
    expect(paymentLines(undefined)).toBeNull();
  });
});

describe("tiers de respaldo", () => {
  it("son los tres del contrato, y se reconocen como respaldo", () => {
    expect(FALLBACK_GIFT_TIERS.map((t) => [t.name, t.amountCop])).toEqual([
      ["Detalle", 50000],
      ["Consentida", 100000],
      ["Golden", 150000],
    ]);
    expect(FALLBACK_GIFT_TIERS.every((t) => isFallbackTier(t.id))).toBe(true);
    expect(isFallbackTier("3f1c2a9e-uuid")).toBe(false);
  });

  it("cada uno tiene su copy en los dos idiomas", async () => {
    for (const lang of ["es", "en"] as const) {
      const dict = (await import(`../app/[lang]/dictionaries/${lang}.json`)).default;
      for (const t of FALLBACK_GIFT_TIERS) expect(dict.regalar.tiers.covers[tierKey(t.name)]).toBeTruthy();
    }
  });
});
