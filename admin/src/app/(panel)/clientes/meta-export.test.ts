import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime, type Customer } from "@/lib/ea";

import type { E164 } from "./identity";
import {
  buildAudience,
  buildMetaCsv,
  metaFilename,
  normalizePhoneForMeta,
  normalizeTextForMeta,
  parseSegment,
  selectSegment,
  sha256Hex,
  type AudiencePerson,
  type AudienceSources,
} from "./meta-export";

const at = (value: string) => parseEaLocalDateTime(value);
const TODAY = parseEaLocalDate("2026-10-15");
const NOW = at("2026-10-15 12:00:00");

/**
 * Vectores de prueba calculados aparte con `node:crypto`
 * (`createHash("sha256").update(v).digest("hex")`), no con la función bajo
 * prueba: un test que compara la función consigo misma no prueba nada.
 */
const SHA = {
  "573001234567": "173afe355201e7ed8e349c576f30ebd4be4314b65e1d87196ae5f75b21518172",
  mariajose: "dd5b32c15fc56be8570bd485aa6baccd685384bd03c9fe947a510376cc4978a6",
  penarios: "a13040e7eda3a168670412435f4e7d41b7d7a74dd4aa67ea678c70e6b116cf38",
  co: "c330ec504d82c24fcd10be978fa74b8a3185a8df719604a85443bb9ca279f5a2",
  bogota: "4f18b075b430429762f19d880df444390a1168662086c74d825bf7f2240a58fc",
} as const;

function customer(id: number, partial: Partial<Customer>): Customer {
  return {
    id,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
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
    notes: null,
    ...partial,
  };
}

function sources(partial: Partial<AudienceSources>): AudienceSources {
  return { customers: [], appointments: [], legacy: [], now: NOW, ...partial };
}

describe("normalización de Meta", () => {
  it("teléfono: dígitos con indicativo, sin +", () => {
    expect(normalizePhoneForMeta("+573001234567" as E164)).toBe("573001234567");
  });

  it("nombres y ciudad: minúsculas a–z, sin tildes, sin puntuación, sin espacios", () => {
    expect(normalizeTextForMeta("  María José ")).toBe("mariajose");
    expect(normalizeTextForMeta("Peña-Ríos")).toBe("penarios");
    expect(normalizeTextForMeta("Bogotá D.C.")).toBe("bogotadc");
    expect(normalizeTextForMeta("O'Neil")).toBe("oneil");
    expect(normalizeTextForMeta(null)).toBe("");
    expect(normalizeTextForMeta("—")).toBe("");
  });

  it("SHA-256 hexadecimal minúscula, igual a node:crypto", () => {
    expect(sha256Hex("573001234567")).toBe(SHA["573001234567"]);
    expect(sha256Hex("co")).toBe(SHA.co);
    expect(sha256Hex("mariajose")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAudience — una persona por teléfono, de las tres fuentes", () => {
  it("dos fichas de EA con el mismo teléfono escrito distinto son una sola clienta", () => {
    const audience = buildAudience(
      sources({
        customers: [
          customer(1, { firstName: "María", phone: "300 123 4567" }),
          customer(2, { firstName: "María José", lastName: "Peña Ríos", phone: "+57 3001234567" }),
        ],
      }),
    );
    expect(audience.people).toHaveLength(1);
    // Gana la fila más completa: la regla de `mergeCustomers()`, no una propia.
    expect(audience.people[0]).toMatchObject({
      phone: "+573001234567",
      firstName: "María José",
      lastName: "Peña Ríos",
    });
  });

  it("cuenta las fichas sin teléfono utilizable en vez de perderlas", () => {
    const audience = buildAudience(
      sources({
        customers: [
          customer(1, { firstName: "Sin", phone: null }),
          customer(2, { firstName: "Mal", phone: "123" }),
          customer(3, { firstName: "Ana", phone: "3001112233" }),
        ],
        legacy: [{ phone: "", name: "Vieja", at: at("2025-01-01 10:00:00"), kind: "atendida" }],
      }),
    );
    expect(audience.people).toHaveLength(1);
    expect(audience.customersWithoutPhone).toBe(2);
    expect(audience.legacyWithoutPhone).toBe(1);
  });

  it("une el histórico de Agenda Pro por teléfono, y suma a quien solo existe ahí", () => {
    const audience = buildAudience(
      sources({
        customers: [customer(1, { firstName: "Ana", lastName: "Ríos", phone: "3001112233" })],
        legacy: [
          { phone: "+573001112233", name: "Ana R", at: at("2025-02-01 10:00:00"), kind: "atendida" },
          { phone: "+573009998877", name: "Lucía Gómez Paz", at: at("2025-03-01 10:00:00"), kind: "atendida" },
        ],
      }),
    );
    expect(audience.people).toHaveLength(2);
    const ana = audience.people.find((p) => p.phone === "+573001112233");
    // El nombre de EA manda sobre el del histórico.
    expect(ana).toMatchObject({ firstName: "Ana", lastName: "Ríos", lastAttended: "2025-02-01 10:00:00" });
    const lucia = audience.people.find((p) => p.phone === "+573009998877");
    expect(lucia).toMatchObject({ firstName: "Lucía", lastName: "Gómez Paz" });
  });

  it("'atendida' es la de los reportes: completada en EA; agendada no es visita; no-show del histórico tampoco", () => {
    const audience = buildAudience(
      sources({
        customers: [customer(1, { firstName: "Ana", phone: "3001112233" })],
        appointments: [
          { customerId: 1, start: at("2026-09-01 10:00:00"), status: "Completada" },
          { customerId: 1, start: at("2026-09-20 10:00:00"), status: "No asistió" },
          { customerId: 1, start: at("2026-09-25 10:00:00"), status: "Confirmada" },
        ],
        legacy: [{ phone: "+573001112233", name: null, at: at("2026-09-28 10:00:00"), kind: "no-asistio" }],
      }),
    );
    expect(audience.people[0].lastAttended).toBe("2026-09-01 10:00:00");
  });

  it("una cita futura no cancelada marca que ya está volviendo; una cancelada no", () => {
    const audience = buildAudience(
      sources({
        customers: [
          customer(1, { firstName: "Con cita", phone: "3001112233" }),
          customer(2, { firstName: "Canceló", phone: "3004445566" }),
        ],
        appointments: [
          { customerId: 1, start: at("2026-10-20 10:00:00"), status: "Reservada" },
          { customerId: 2, start: at("2026-10-20 10:00:00"), status: "Cancelada" },
          // Pasada y sin cerrar: no es futura.
          { customerId: 2, start: at("2026-10-01 10:00:00"), status: "Reservada" },
        ],
      }),
    );
    const byName = Object.fromEntries(audience.people.map((p) => [p.firstName, p.hasUpcoming]));
    expect(byName).toEqual({ "Con cita": true, "Canceló": false });
  });

  it("toma la ciudad de cualquiera de sus fichas", () => {
    const audience = buildAudience(
      sources({
        customers: [
          customer(1, { firstName: "Ana", phone: "3001112233" }),
          customer(2, { firstName: "Ana", phone: "300 111 2233", city: "Bogotá" }),
        ],
      }),
    );
    expect(audience.people[0].city).toBe("Bogotá");
  });
});

describe("selectSegment", () => {
  const person = (phone: string, lastAttended: string | null, hasUpcoming = false): AudiencePerson => ({
    phone: phone as E164,
    firstName: "x",
    lastName: "",
    city: null,
    lastAttended: lastAttended === null ? null : at(lastAttended),
    hasUpcoming,
  });

  const PEOPLE = [
    person("+573000000001", "2026-10-10 10:00:00"), // hace 5 días
    person("+573000000002", "2026-04-18 10:00:00"), // justo hoy − 180: entra
    person("+573000000003", "2026-04-17 10:00:00"), // hoy − 181: no entra
    person("+573000000004", "2026-08-16 10:00:00"), // justo hoy − 60: todavía no es inactiva
    person("+573000000005", "2026-08-15 10:00:00"), // hoy − 61: inactiva
    person("+573000000006", "2026-01-01 10:00:00", true), // inactiva pero con cita: fuera
    person("+573000000007", null), // nunca atendida
  ];

  const phones = (list: AudiencePerson[]) => list.map((p) => p.phone.slice(-1));

  it("todas: cada clienta con teléfono, haya venido o no", () => {
    expect(selectSegment(PEOPLE, "todas", TODAY)).toHaveLength(7);
  });

  it("últimos 180 días, con el borde inclusivo", () => {
    expect(phones(selectSegment(PEOPLE, "ultimos-180", TODAY))).toEqual(["1", "2", "4", "5"]);
  });

  it("inactivas: vinieron, no en los últimos 60 días, y sin cita futura", () => {
    expect(phones(selectSegment(PEOPLE, "inactivas-60", TODAY))).toEqual(["2", "3", "5"]);
  });

  it("las dos listas de pauta no se pisan: nadie activo hace 60 días es inactiva", () => {
    const lapsed = new Set(selectSegment(PEOPLE, "inactivas-60", TODAY).map((p) => p.phone));
    for (const p of PEOPLE) {
      if (p.lastAttended !== null && p.lastAttended >= at("2026-08-16 00:00:00")) {
        expect(lapsed.has(p.phone)).toBe(false);
      }
    }
  });
});

describe("buildMetaCsv", () => {
  const ana: AudiencePerson = {
    phone: "+573001234567" as E164,
    firstName: "María José",
    lastName: "Peña-Ríos",
    city: null,
    lastAttended: null,
    hasUpcoming: false,
  };

  it("columnas de Meta, todo cifrado con los vectores de node:crypto", () => {
    expect(buildMetaCsv([ana])).toBe(
      `phone,fn,ln,country\n${SHA["573001234567"]},${SHA.mariajose},${SHA.penarios},${SHA.co}\n`,
    );
  });

  it("ningún teléfono ni nombre viaja en claro", () => {
    const csv = buildMetaCsv([ana]);
    expect(csv).not.toContain("3001234567");
    expect(csv.toLowerCase()).not.toContain("maria");
  });

  it("agrega ct solo si alguien trae ciudad, y deja vacía la celda de quien no", () => {
    const csv = buildMetaCsv([{ ...ana, city: "Bogotá" }, { ...ana, phone: "+573009998877" as E164 }]);
    const [header, first, second] = csv.trim().split("\n");
    expect(header).toBe("phone,fn,ln,ct,country");
    expect(first.split(",")[3]).toBe(SHA.bogota);
    expect(second.split(",")[3]).toBe("");
  });

  it("un apellido vacío va vacío, nunca el hash de la cadena vacía", () => {
    const csv = buildMetaCsv([{ ...ana, lastName: "" }]);
    expect(csv.trim().split("\n")[1].split(",")[2]).toBe("");
    expect(csv).not.toContain(sha256Hex(""));
  });

  it("no le inventa país a un número que no es de Colombia", () => {
    const csv = buildMetaCsv([{ ...ana, phone: "+13055550123" as E164 }]);
    expect(csv.trim().split("\n")[1].split(",")[3]).toBe("");
  });

  it("una lista vacía es solo el encabezado", () => {
    expect(buildMetaCsv([])).toBe("phone,fn,ln,country\n");
  });
});

describe("segmento y nombre de archivo", () => {
  it("parseSegment solo acepta los tres", () => {
    expect(parseSegment("todas")).toBe("todas");
    expect(parseSegment("ultimos-180")).toBe("ultimos-180");
    expect(parseSegment("inactivas-60")).toBe("inactivas-60");
    expect(parseSegment("todo")).toBeNull();
    expect(parseSegment(undefined)).toBeNull();
  });

  it("golden-meta-<segmento>-<fecha>.csv", () => {
    expect(metaFilename("ultimos-180", TODAY)).toBe("golden-meta-ultimos-180-2026-10-15.csv");
  });
});
