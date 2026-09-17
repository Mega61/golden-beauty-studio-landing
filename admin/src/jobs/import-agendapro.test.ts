import { describe, expect, it } from "vitest";

import {
  applyColumns,
  cleanEmail,
  detectColumns,
  headerKey,
  isPaid,
  parseAgendaproDate,
  parseAmount,
  parseDelimited,
  planCustomers,
  planLegacy,
  splitName,
  type RawRow,
} from "./import-agendapro";

/** Fecha simple, para los tests que no están probando el parseo de fechas. */
const parseDate = (raw: string): Date | null => {
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
};

describe("parseDelimited", () => {
  it("lee un CSV con coma", () => {
    expect(parseDelimited("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("lee un CSV con punto y coma, que es lo que exporta un Excel en español", () => {
    expect(parseDelimited("Nombre;Teléfono\nAna;3001234567")).toEqual([
      ["Nombre", "Teléfono"],
      ["Ana", "3001234567"],
    ]);
  });

  it("respeta las comas dentro de comillas", () => {
    // Un nombre de servicio como "Uñas acrílicas, forrado" es el caso normal.
    expect(parseDelimited('a,b\n"Uñas acrílicas, forrado",115000')).toEqual([
      ["a", "b"],
      ["Uñas acrílicas, forrado", "115000"],
    ]);
  });

  it("entiende una comilla escapada duplicándola", () => {
    expect(parseDelimited('a\n"Dijo ""hola"""')).toEqual([["a"], ['Dijo "hola"']]);
  });

  it("aguanta un salto de línea dentro de un campo entrecomillado", () => {
    // Una nota de la cita con enter adentro. Sin esto, la fila se parte en dos
    // y la segunda mitad aparece como una clienta sin teléfono.
    expect(parseDelimited('a,b\n"linea1\nlinea2",x')).toEqual([
      ["a", "b"],
      ["linea1\nlinea2", "x"],
    ]);
  });

  it("aguanta CRLF", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("se come el BOM de Excel", () => {
    // Sin esto, el primer encabezado no coincide con ningún sinónimo y la
    // columna más importante del archivo queda sin detectar.
    const [header] = parseDelimited("﻿Teléfono,Nombre\n1,2");
    expect(headerKey(header[0])).toBe("telefono");
  });

  it("no inventa una fila al final por el salto de línea", () => {
    expect(parseDelimited("a\n1\n")).toHaveLength(2);
  });

  it("conserva una fila con campos vacíos, que no es lo mismo que una línea en blanco", () => {
    expect(parseDelimited("a,b\n,\n")).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
  });
});

describe("detectColumns", () => {
  it("encuentra las columnas de un encabezado en español, con tildes", () => {
    const map = detectColumns(["Fecha", "Cliente", "Teléfono", "Servicio", "Total", "Estado"]);

    expect(map).toEqual({
      startedAt: 0,
      name: 1,
      phone: 2,
      serviceName: 3,
      amount: 4,
      status: 5,
    });
  });

  it("encuentra las de un encabezado en inglés", () => {
    const map = detectColumns(["Date", "Name", "Phone", "Service"]);
    expect(map).toMatchObject({ startedAt: 0, name: 1, phone: 2, serviceName: 3 });
  });

  it("ignora mayúsculas, espacios y acentos", () => {
    expect(detectColumns(["  TELÉFONO MÓVIL  "])).toEqual({ phone: 0 });
  });

  it("no inventa columnas que no están", () => {
    expect(detectColumns(["Columna rara"])).toEqual({});
  });

  it("con dos columnas parecidas se queda con la primera", () => {
    // Arbitrario y dicho: el CLI lo imprime y se puede anular a mano.
    expect(detectColumns(["Teléfono", "Celular"])).toMatchObject({ phone: 0 });
  });
});

describe("applyColumns", () => {
  it("recorta y descarta los vacíos", () => {
    expect(applyColumns(["  Ana  ", "", "  "], { name: 0, email: 1, phone: 2 })).toEqual({
      name: "Ana",
    });
  });

  it("no revienta con una fila más corta que el encabezado", () => {
    // Pasa de verdad: la última columna vacía a veces no se escribe.
    expect(applyColumns(["Ana"], { name: 0, phone: 1 })).toEqual({ name: "Ana" });
  });
});

describe("splitName", () => {
  it("usa las dos columnas cuando existen", () => {
    expect(splitName("Ana", "Ríos")).toEqual({ firstName: "Ana", lastName: "Ríos" });
  });

  it("parte en el primer espacio cuando hay una sola", () => {
    expect(splitName("Ana Ríos", undefined)).toEqual({ firstName: "Ana", lastName: "Ríos" });
  });

  it("todo lo que sigue al primer espacio es apellido", () => {
    // "Ana María Ríos Pérez" queda mal partido y da igual: lo que importa es que
    // el nombre completo se conserve para que la clienta se reconozca.
    expect(splitName("Ana María Ríos Pérez", undefined)).toEqual({
      firstName: "Ana",
      lastName: "María Ríos Pérez",
    });
  });

  it("un solo nombre deja el apellido vacío, no lo inventa", () => {
    expect(splitName("Ana", undefined)).toEqual({ firstName: "Ana", lastName: "" });
  });

  it("sin nombre devuelve dos vacíos", () => {
    expect(splitName(undefined, undefined)).toEqual({ firstName: "", lastName: "" });
  });
});

describe("cleanEmail", () => {
  it("acepta un correo real y lo baja a minúsculas", () => {
    expect(cleanEmail("  Ana@Gmail.COM ")).toBe("ana@gmail.com");
  });

  it("rechaza lo que no es un correo", () => {
    for (const value of ["", "   ", "ana", "ana@", "@gmail.com", "ana gmail.com"]) {
      expect(cleanEmail(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("rechaza los correos de relleno", () => {
    // Un correo falso viaja como attendee del evento de Google, rebota, y
    // ensucia la ficha para siempre. Importarlos sería sembrar de nuevo el
    // problema que `identity.ts` ya detecta.
    for (const value of ["sin@correo.com", "noemail@agendapro.com", "na@na.com"]) {
      expect(cleanEmail(value), value).toBeNull();
    }
  });
});

describe("parseAmount", () => {
  it("lee el formato colombiano", () => {
    expect(parseAmount("$ 115.000")).toBe(115_000);
    expect(parseAmount("115.000")).toBe(115_000);
    expect(parseAmount("115000")).toBe(115_000);
  });

  it("el punto es separador de miles, no decimal", () => {
    // "1.500" son mil quinientos pesos. Adivinar por la cantidad de dígitos lo
    // volvería 1,5 y el reporte del año pasado quedaría dividido por mil.
    expect(parseAmount("1.500")).toBe(1_500);
  });

  it("descarta los decimales en vez de redondear", () => {
    // Colombia no tiene centavos: aceptar "115.000,50" como 115.001 metería un
    // peso fantasma en un reporte histórico.
    expect(parseAmount("115.000,50")).toBe(115_000);
  });

  it("entiende un monto negativo", () => {
    expect(parseAmount("-20.000")).toBe(-20_000);
  });

  it("devuelve null cuando no hay monto, y eso no es cero", () => {
    // `null` es "el export no traía la plata". Un cero sería afirmar que la
    // cita fue gratis, y eso después se suma en un reporte.
    for (const value of [undefined, "", "   ", "N/A", "-", "$"]) {
      expect(parseAmount(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("planCustomers", () => {
  const row = (over: Partial<RawRow> = {}): RawRow => ({
    phone: "3001234567",
    name: "Ana Ríos",
    ...over,
  });

  it("crea una clienta por teléfono", () => {
    const plan = planCustomers({ rows: [row()], existing: [] });

    expect(plan.create).toEqual([
      { phone: "+573001234567", firstName: "Ana", lastName: "Ríos", email: null, rows: 1 },
    ]);
  });

  it("agrupa las filas que comparten teléfono en una sola clienta", () => {
    // Un export de citas trae una fila por cita: la misma clienta aparece
    // veinte veces. Crear veinte clientas sería destruir la base al importarla.
    const plan = planCustomers({
      rows: [row(), row(), row()],
      existing: [],
    });

    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].rows).toBe(3);
  });

  it("agrupa aunque el número esté escrito distinto", () => {
    const plan = planCustomers({
      rows: [row({ phone: "3001234567" }), row({ phone: "+57 300 123 4567" })],
      existing: [],
    });

    expect(plan.create).toHaveLength(1);
  });

  it("se queda con el nombre más largo de las variantes", () => {
    // El número es lo que identifica; el nombre es lo que se escribió ese día.
    // Elegir el primero dejaría "Ana M." de por vida solo porque esa cita fue
    // antes.
    const plan = planCustomers({
      rows: [row({ name: "Ana M." }), row({ name: "Ana María Ríos" })],
      existing: [],
    });

    expect(`${plan.create[0].firstName} ${plan.create[0].lastName}`.trim()).toBe(
      "Ana María Ríos",
    );
  });

  it("no crea a quien EA ya tiene con ese teléfono", () => {
    const plan = planCustomers({
      rows: [row()],
      existing: [{ id: 7, phone: "+573001234567", name: "Ana Ríos" }],
    });

    expect(plan.create).toEqual([]);
    expect(plan.existing).toEqual([
      { phone: "+573001234567", eaCustomerId: 7, name: "Ana Ríos" },
    ]);
  });

  it("compara contra EA con el número normalizado, no con el texto", () => {
    // EA guarda lo que alguien escribió. Comparar cadenas crearía un duplicado
    // por cada clienta cuyo número esté escrito distinto de los dos lados.
    const plan = planCustomers({
      rows: [row({ phone: "+573001234567" })],
      existing: [{ id: 7, phone: "300 123 4567", name: "Ana" }],
    });

    expect(plan.create).toEqual([]);
  });

  it("separa las filas sin teléfono utilizable, y no las descarta en silencio", () => {
    // Son las clientas a las que hay que llamar para pedirles el número. Que se
    // pierdan sin decir nada es la forma más fácil de perder media base.
    const plan = planCustomers({
      rows: [row({ phone: "N/A" }), row({ phone: "sin teléfono", name: "Otra" })],
      existing: [],
    });

    expect(plan.create).toEqual([]);
    expect(plan.unusable).toHaveLength(2);
    expect(plan.unusable[0]).toMatchObject({ raw: "N/A" });
  });

  it("cuenta cuántas filas trae cada caso sin teléfono", () => {
    const plan = planCustomers({
      rows: [row({ phone: "N/A" }), row({ phone: "N/A" })],
      existing: [],
    });

    expect(plan.unusable).toHaveLength(1);
    expect(plan.unusable[0].rows).toBe(2);
  });

  it("copia el correo cuando es real y lo deja en null cuando no", () => {
    const conCorreo = planCustomers({
      rows: [row({ email: "ana@gmail.com" })],
      existing: [],
    });
    const conRelleno = planCustomers({
      rows: [row({ email: "sin@correo.com" })],
      existing: [],
    });

    expect(conCorreo.create[0].email).toBe("ana@gmail.com");
    expect(conRelleno.create[0].email).toBeNull();
  });

  it("el plan es estable: dos corridas del mismo archivo dan el mismo orden", () => {
    // Es lo que deja comparar el plan de hoy con el de ayer antes de aplicar.
    const rows = [row({ phone: "3009999999" }), row({ phone: "3001111111" })];
    const a = planCustomers({ rows, existing: [] });
    const b = planCustomers({ rows: [...rows].reverse(), existing: [] });

    expect(a.create.map((c) => c.phone)).toEqual(b.create.map((c) => c.phone));
  });
});

describe("planLegacy", () => {
  const row = (over: Partial<RawRow> = {}): RawRow => ({
    phone: "3001234567",
    name: "Ana Ríos",
    startedAt: "2025-03-04T14:00:00Z",
    serviceName: "Acrílicas esculpidas",
    amount: "115.000",
    ...over,
  });

  it("arma la fila del histórico", () => {
    const { rows } = planLegacy({ rows: [row({ sourceId: "AP-1" })], parseDate });

    expect(rows[0]).toMatchObject({
      source_id: "AP-1",
      client_phone_e164: "+573001234567",
      client_name: "Ana Ríos",
      service_name: "Acrílicas esculpidas",
      amount_charged: 115_000,
    });
  });

  it("guarda el monto en null cuando el export no lo trae", () => {
    const { rows } = planLegacy({ rows: [row({ amount: undefined })], parseDate });
    expect(rows[0].amount_charged).toBeNull();
  });

  it("guarda la clienta sin teléfono igual, con el teléfono en null", () => {
    // La cita pasó. Descartarla porque falta el número perdería historia real;
    // lo que se pierde es solo poder atarla a una clienta.
    const { rows } = planLegacy({ rows: [row({ phone: "N/A" })], parseDate });

    expect(rows).toHaveLength(1);
    expect(rows[0].client_phone_e164).toBeNull();
  });

  it("salta las filas sin fecha y dice en qué línea", () => {
    const { rows, skipped } = planLegacy({
      rows: [row({ startedAt: "no es fecha" })],
      parseDate,
    });

    expect(rows).toEqual([]);
    expect(skipped).toEqual([{ reason: "sin-fecha", line: 2 }]);
  });

  it("salta las filas sin servicio", () => {
    // `service_name` es NOT NULL en la migración `014`, y un "(sin servicio)"
    // inventado se lee después como si hubiera sido un servicio real.
    const { skipped } = planLegacy({ rows: [row({ serviceName: undefined })], parseDate });
    expect(skipped).toEqual([{ reason: "sin-servicio", line: 2 }]);
  });

  it("deriva un source_id estable cuando el export no trae id", () => {
    const a = planLegacy({ rows: [row()], parseDate });
    const b = planLegacy({ rows: [row()], parseDate });

    expect(a.rows[0].source_id).toBe(b.rows[0].source_id);
    expect(a.rows[0].source_id.length).toBeLessThanOrEqual(64);
  });

  it("dos citas distintas del mismo día no comparten el id derivado", () => {
    const { rows } = planLegacy({
      rows: [row(), row({ startedAt: "2025-03-04T16:00:00Z" })],
      parseDate,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].source_id).not.toBe(rows[1].source_id);
  });

  it("descarta un id repetido dentro del mismo archivo en vez de perderlo callado", () => {
    // Pasa de verdad: el export real trae una cita cancelada triplicada.
    const { rows, skipped } = planLegacy({
      rows: [row({ sourceId: "AP-1" }), row({ sourceId: "AP-1" })],
      parseDate,
    });

    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ reason: "duplicada", line: 3 }]);
  });

  it("el id derivado distingue dos citas de la misma clienta a la misma hora", () => {
    // Suena imposible y pasa: una cita corregida y recreada en el export viejo.
    // Si los ids coincidieran, una de las dos se perdería en el import.
    const { rows } = planLegacy({
      rows: [row(), row({ serviceName: "Semipermanente" })],
      parseDate,
    });

    expect(new Set(rows.map((r) => r.source_id)).size).toBe(2);
  });
});

describe("parseAgendaproDate", () => {
  /** La hora de pared que un instante tiene en Bogotá. */
  const enBogota = (value: Date | null): string | null =>
    value === null
      ? null
      : new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Bogota",
          dateStyle: "short",
          timeStyle: "medium",
        }).format(value);

  it("lee el día primero, que es lo que usa Colombia", () => {
    // Es la decisión de la que depende todo el histórico: `03/04/2025` es el 3
    // de abril, no el 4 de marzo. Las dos lecturas producen una fecha válida, y
    // por eso el error no falla: importa dos años con los meses corridos.
    expect(enBogota(parseAgendaproDate("03/04/2025 14:00"))).toBe("2025-04-03 14:00:00");
  });

  it("y con un día mayor que 12 sigue leyendo día primero", () => {
    expect(enBogota(parseAgendaproDate("25/12/2025 09:30"))).toBe("2025-12-25 09:30:00");
  });

  it("lee ISO por su forma, sin ambigüedad", () => {
    expect(enBogota(parseAgendaproDate("2025-04-03 14:00"))).toBe("2025-04-03 14:00:00");
    expect(enBogota(parseAgendaproDate("2025-04-03T14:00:00"))).toBe("2025-04-03 14:00:00");
  });

  it("acepta guiones y puntos como separadores", () => {
    expect(enBogota(parseAgendaproDate("3-4-2025 14:00"))).toBe("2025-04-03 14:00:00");
    expect(enBogota(parseAgendaproDate("3.4.2025 14:00"))).toBe("2025-04-03 14:00:00");
  });

  it("entiende a. m. y p. m.", () => {
    expect(enBogota(parseAgendaproDate("03/04/2025 2:00 p.m."))).toBe("2025-04-03 14:00:00");
    expect(enBogota(parseAgendaproDate("03/04/2025 2:00 a.m."))).toBe("2025-04-03 02:00:00");
  });

  it("las 12 a. m. son medianoche y las 12 p. m. son mediodía", () => {
    expect(enBogota(parseAgendaproDate("03/04/2025 12:00 a.m."))).toBe("2025-04-03 00:00:00");
    expect(enBogota(parseAgendaproDate("03/04/2025 12:00 p.m."))).toBe("2025-04-03 12:00:00");
  });

  it("una fecha sin hora se ancla al mediodía, no a medianoche", () => {
    // A medianoche, cualquier corrimiento cruza al día anterior y la cita
    // aparece un día antes en la ficha de la clienta.
    expect(enBogota(parseAgendaproDate("03/04/2025"))).toBe("2025-04-03 12:00:00");
  });

  it("la hora es hora de pared de Bogotá, no UTC", () => {
    // Bogotá es UTC-5: las 2 p. m. locales son las 19:00Z. Si el importador
    // tomara la hora como UTC, cada cita del histórico quedaría cinco horas
    // corrida y las de la mañana temprano cambiarían de día.
    expect(parseAgendaproDate("03/04/2025 14:00")?.toISOString()).toBe(
      "2025-04-03T19:00:00.000Z",
    );
  });

  it("un año de dos cifras es de este siglo", () => {
    expect(enBogota(parseAgendaproDate("03/04/25 14:00"))).toBe("2025-04-03 14:00:00");
  });

  it("rechaza una fecha que no existe en el calendario", () => {
    // El 31 de febrero parsea como 3 de marzo en la aritmética de fechas. Una
    // fecha imposible es un error del export, no una cita.
    expect(parseAgendaproDate("31/02/2025")).toBeNull();
    expect(parseAgendaproDate("32/01/2025")).toBeNull();
  });

  it("rechaza un mes imposible", () => {
    expect(parseAgendaproDate("03/13/2025")).toBeNull();
  });

  it("rechaza una hora imposible", () => {
    expect(parseAgendaproDate("03/04/2025 25:00")).toBeNull();
    expect(parseAgendaproDate("03/04/2025 14:99")).toBeNull();
  });

  it("devuelve null con lo que no es una fecha", () => {
    for (const value of ["", "   ", "N/A", "sin fecha", "abc"]) {
      expect(parseAgendaproDate(value), JSON.stringify(value)).toBeNull();
    }
  });
});

/**
 * El encabezado **exacto** del export real de Agenda Pro (2026-09-14, 173
 * citas). Transcrito, no inventado: es el contrato que este importador tiene
 * que cumplir, y el día que Agenda Pro cambie una columna, este test lo dice.
 */
const ENCABEZADO_REAL = [
  "Fecha de realización",
  "Fecha de creación",
  "Responsable creación",
  "Fecha última modificación",
  "Responsable última modificación",
  "Local",
  "N° de Cliente",
  "Nombre",
  "Apellido",
  "E-mail",
  "Teléfono",
  "N.º de identificación ",
  "Servicio",
  "Precio lista",
  "Precio real",
  "Nº de sesión",
  "Sesiones Totales",
  "Prestador",
  "Estado",
  "Estado de pago",
  "Fecha pago",
  "ID pago",
  "Notas compartidas con cliente",
  "Comentario interno",
  "Preferencia Cliente",
  "Origen",
];

describe("el export real de Agenda Pro", () => {
  const map = detectColumns(ENCABEZADO_REAL);

  it("encuentra las nueve columnas que el importador usa", () => {
    expect(map).toEqual({
      startedAt: 0,
      name: 7,
      lastName: 8,
      email: 9,
      phone: 10,
      serviceName: 12,
      amount: 14,
      providerName: 17,
      status: 18,
      paidStatus: 19,
    });
  });

  it("⚠ toma «Precio real» y no «Precio lista»", () => {
    // Es el hallazgo más caro del archivo: en 96 de 173 filas las dos columnas
    // difieren. Importar la de lista no falla — infla el histórico de ingresos
    // y nadie lo nota, porque el número se ve razonable.
    expect(map.amount).toBe(ENCABEZADO_REAL.indexOf("Precio real"));
    expect(map.amount).not.toBe(ENCABEZADO_REAL.indexOf("Precio lista"));
  });

  it("⚠ toma «Fecha de realización» y no las otras tres fechas", () => {
    // El archivo trae cuatro columnas de fecha. Las otras describen el
    // registro —cuándo se creó, cuándo se modificó, cuándo se pagó— y usarlas
    // pondría cada cita en el día en que alguien la escribió.
    expect(map.startedAt).toBe(0);
  });

  it("no confunde «Estado» con «Estado de pago»", () => {
    expect(map.status).toBe(18);
    expect(map.paidStatus).toBe(19);
  });

  it("no toma «N° de Cliente» ni «ID pago» como id de la cita", () => {
    // El export **no trae** id de cita, así que el id se deriva. Tomar
    // cualquiera de esos dos como llave fusionaría citas distintas.
    expect(map.sourceId).toBeUndefined();
  });

  it("lee una fila real de punta a punta", () => {
    const fila = [
      "29/09/2026 15:00",
      "11/09/2026 10:47",
      "mariana.garari@goldenbeautystudio.com.co",
      "11/09/2026 10:47",
      "mariana.garari@goldenbeautystudio.com.co",
      "Golden Beauty Studio",
      "",
      "Julian",
      "_",
      "",
      "+573187050207",
      "",
      "Limpieza pies y manos",
      "45000",
      "45000",
      "NA",
      "NA",
      "Mariana",
      "Reservado",
      "No pagada",
      "",
      "",
      "",
      "",
      "Sin Preferencia",
      "Manual",
    ];

    const raw = applyColumns(fila, map);
    const { rows } = planLegacy({ rows: [raw], parseDate: (v) => parseAgendaproDate(v) });

    expect(rows[0]).toMatchObject({
      client_phone_e164: "+573187050207",
      // El apellido "_" no viaja: dejaría una clienta llamada "Julian _" y ese
      // nombre va en la confirmación de la cita.
      client_name: "Julian",
      service_name: "Limpieza pies y manos",
      provider_name: "Mariana",
      status: "Reservado",
      // Sin pagar ⇒ sin monto. El precio existe, la plata no entró.
      amount_charged: null,
    });
  });

  it("y con el pago asociado, sí trae el monto", () => {
    const raw = applyColumns(
      ["01/06/2026 16:00", "", "", "", "", "", "", "Ana", "Ríos", "", "+573001234567", "",
       "Press on", "150000", "135000", "", "", "Kati", "Asiste", "Pago asociado"],
      map,
    );
    const { rows } = planLegacy({ rows: [raw], parseDate: (v) => parseAgendaproDate(v) });

    expect(rows[0].amount_charged).toBe(135_000);
  });

  it("las fechas del archivo son día primero, y el rango lo confirma", () => {
    // El export va del 01/06/2026 al 31/08/2026. Leído al revés, el 31/08 no
    // existiría como fecha (no hay mes 31) — que es la señal más barata de que
    // el orden está bien.
    expect(parseAgendaproDate("31/08/2026 12:30")).not.toBeNull();
    expect(parseAgendaproDate("01/06/2026 16:00")?.toISOString()).toBe(
      "2026-06-01T21:00:00.000Z",
    );
  });
});

describe("isPaid", () => {
  it("«Pago asociado» y «Pagada» cuentan como pagadas", () => {
    for (const value of ["Pago asociado", "Pagada", "Pagado", "PAGADA"]) {
      expect(isPaid(value), value).toBe(true);
    }
  });

  it("«No pagada» y sus parientes, no", () => {
    for (const value of ["No pagada", "no pagado", "Sin pago", "Pendiente de pago"]) {
      expect(isPaid(value), value).toBe(false);
    }
  });

  it("sin columna de estado de pago, se cuenta como pagada", () => {
    // Una lista blanca incompleta convertiría un cobro real en `null`, que es
    // perder plata del reporte. Ante la duda, se cuenta.
    expect(isPaid(undefined)).toBe(true);
    expect(isPaid("")).toBe(true);
  });
});
