import { describe, expect, it } from "vitest";

import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea";

import {
  addCalendarDays,
  DEFAULT_WINBACK_TEMPLATE,
  displayPhone,
  filterWinback,
  formatDayMonth,
  renderWinbackMessage,
  selectWinbackCandidates,
  unknownFields,
  winbackDiscountApplies,
  type WinbackPerson,
  type WinbackValues,
} from "./winback";

const at = (s: string) => s as EaLocalDateTime;
const day = (s: string) => s as EaLocalDate;

const values: WinbackValues = {
  nombre: "Laura",
  sellos: "3",
  meta: "8",
  premio: "Manicure gratis",
  descuento: "10",
  vence: "10 de diciembre",
  link: "https://stampee.example/golden/abc?src=whatsapp",
  reservar: "https://goldenbeautystudio.com.co/reservar",
};

describe("renderWinbackMessage", () => {
  it("pone todos los campos de la plantilla por defecto", () => {
    const text = renderWinbackMessage(DEFAULT_WINBACK_TEMPLATE, values);
    expect(text).toContain("¡Hola, Laura! 💛");
    expect(text).toContain("*3 sellos de regalo*");
    expect(text).toContain("*10% de descuento*");
    expect(text).toContain("Válido hasta el 10 de diciembre.");
    expect(text).toContain("👉 Tu tarjeta: https://stampee.example/golden/abc?src=whatsapp");
    expect(text).not.toMatch(/\{[a-z]+\}/);
  });

  it("sin descuento ni vencimiento quita esos renglones", () => {
    const text = renderWinbackMessage(DEFAULT_WINBACK_TEMPLATE, { ...values, descuento: null, vence: null });
    expect(text).not.toContain("descuento");
    expect(text).not.toContain("Válido");
    expect(text).toContain("sellos de regalo");
  });

  it("sin nombre saluda sin coma", () => {
    expect(renderWinbackMessage("¡Hola, {nombre}! 💛\nhola", { ...values, nombre: null })).toBe("¡Hola! 💛\nhola");
  });

  it("no deja renglones en blanco repetidos ni al final", () => {
    const text = renderWinbackMessage("a\n\n{vence}\n\nb\n\n{vence}", { ...values, vence: null });
    expect(text).toBe("a\n\nb");
  });

  it("un campo mal escrito se avisa y su renglón no sale", () => {
    expect(unknownFields("Hola {nombre} {nobre}")).toEqual(["nobre"]);
    expect(renderWinbackMessage("a\n{nobre}\nb", values)).toBe("a\nb");
  });
});

describe("fechas", () => {
  it("escribe la fecha en español", () => {
    expect(formatDayMonth("2026-12-01")).toBe("1 de diciembre");
  });
  it("suma días cruzando mes y año", () => {
    expect(addCalendarDays("2026-11-10", 30)).toBe("2026-12-10");
    expect(addCalendarDays("2026-12-20", 15)).toBe("2027-01-04");
  });
});

describe("winbackDiscountApplies", () => {
  const offer = { discountPercent: 10, sentAt: at("2026-11-10 10:00:00"), expiresOn: "2026-12-10" };

  it("vale en la primera visita después de mandarlo", () => {
    expect(winbackDiscountApplies(offer, at("2026-11-15 14:00:00"), false)).toBe(true);
  });
  it("vale el último día y no el siguiente", () => {
    expect(winbackDiscountApplies(offer, at("2026-12-10 18:00:00"), false)).toBe(true);
    expect(winbackDiscountApplies(offer, at("2026-12-11 09:00:00"), false)).toBe(false);
  });
  it("se gasta con la primera visita atendida", () => {
    expect(winbackDiscountApplies(offer, at("2026-11-20 14:00:00"), true)).toBe(false);
  });
  it("no vale antes de mandarlo, sin oferta ni con descuento apagado", () => {
    expect(winbackDiscountApplies(offer, at("2026-11-09 14:00:00"), false)).toBe(false);
    expect(winbackDiscountApplies(null, at("2026-11-15 14:00:00"), false)).toBe(false);
    expect(winbackDiscountApplies({ ...offer, discountPercent: 0 }, at("2026-11-15 14:00:00"), false)).toBe(false);
  });
  it("sin vencimiento vale siempre hasta usarlo", () => {
    expect(winbackDiscountApplies({ ...offer, expiresOn: null }, at("2027-06-01 10:00:00"), false)).toBe(true);
  });
});

describe("selectWinbackCandidates", () => {
  const person = (phone: string, last: string | null, visits = 1, hasUpcoming = false): WinbackPerson => ({
    phone,
    firstName: "Ana",
    lastName: "",
    lastAttended: last === null ? null : at(`${last} 10:00:00`),
    hasUpcoming,
    visits,
  });

  it("filtra por días sin venir, cita agendada, baja y regalo ya mandado", () => {
    const { pending, sent } = selectWinbackCandidates({
      people: [
        person("+571", "2026-09-01"),
        person("+572", "2026-11-01"), // vino hace poco
        person("+573", "2026-08-01", 1, true), // ya tiene cita
        person("+574", "2026-08-01"), // pidió baja
        person("+575", "2026-07-01"), // ya se le mandó
        person("+576", null), // nunca vino
      ],
      today: day("2026-11-10"),
      lapsedDays: 45,
      optedOut: new Set(["+574"]),
      sent: new Map([["+575", { sentAt: at("2026-11-09 10:00:00"), cameBack: false }]]),
    });
    expect(pending.map((p) => p.phone)).toEqual(["+571"]);
    expect(pending[0].daysAway).toBe(70);
    expect(sent.map((p) => p.phone)).toEqual(["+575"]);
  });

  it("primero las que más vinieron, luego la que se fue hace menos", () => {
    const { pending } = selectWinbackCandidates({
      people: [person("+57a", "2026-08-01", 2), person("+57b", "2026-07-01", 5), person("+57c", "2026-09-01", 2)],
      today: day("2026-11-10"),
      lapsedDays: 30,
      optedOut: new Set(),
      sent: new Map(),
    });
    expect(pending.map((p) => p.phone)).toEqual(["+57b", "+57c", "+57a"]);
  });
});

describe("filterWinback", () => {
  const row = (phone: string, name: string, daysAway: number, visits: number, cameBack?: boolean) => ({
    phone,
    firstName: name,
    lastName: "Gómez",
    lastAttended: at("2026-08-01 10:00:00"),
    hasUpcoming: false,
    visits,
    daysAway,
    sent: cameBack === undefined ? null : { sentAt: at("2026-11-01 10:00:00"), cameBack },
  });
  const rows = [row("+573001112222", "Ána", 50, 2), row("+573009998888", "Bea", 120, 5), row("+573005554444", "Carla", 400, 1)];

  it("busca por nombre sin tildes y por tramo del celular", () => {
    expect(filterWinback(rows, { query: "ana" }).map((r) => r.firstName)).toEqual(["Ána"]);
    expect(filterWinback(rows, { query: "999 888" }).map((r) => r.firstName)).toEqual(["Bea"]);
    expect(filterWinback(rows, { query: "gomez" })).toHaveLength(3);
  });

  it("filtra por meses sin venir", () => {
    expect(filterWinback(rows, { query: "", range: "1-3" }).map((r) => r.firstName)).toEqual(["Ána"]);
    expect(filterWinback(rows, { query: "", range: "3-6" }).map((r) => r.firstName)).toEqual(["Bea"]);
    expect(filterWinback(rows, { query: "", range: "6+" }).map((r) => r.firstName)).toEqual(["Carla"]);
  });

  it("ordena", () => {
    expect(filterWinback(rows, { query: "", sort: "visitas" }).map((r) => r.firstName)).toEqual(["Bea", "Ána", "Carla"]);
    expect(filterWinback(rows, { query: "", sort: "antigua" }).map((r) => r.firstName)).toEqual(["Carla", "Bea", "Ána"]);
    expect(filterWinback(rows, { query: "", sort: "nombre" }).map((r) => r.firstName)).toEqual(["Ána", "Bea", "Carla"]);
  });

  it("separa las que volvieron de las que esperan", () => {
    const sent = [row("+571", "A", 10, 1, true), row("+572", "B", 10, 1, false)];
    expect(filterWinback(sent, { query: "", outcome: "volvieron" }).map((r) => r.firstName)).toEqual(["A"]);
    expect(filterWinback(sent, { query: "", outcome: "esperando" }).map((r) => r.firstName)).toEqual(["B"]);
  });

  it("muestra el celular legible", () => {
    expect(displayPhone("+573001234567")).toBe("300 123 4567");
  });
});
