import { describe, expect, it } from "vitest";
import {
  listShape,
  secondaryLine,
  visibleColumns,
  type Column,
} from "./table-model";

type Cita = {
  id: string;
  clienta: string;
  hora: string;
  tecnica: string;
  servicio: string;
  total: string;
  estado: string;
};

const columns: Column<Cita>[] = [
  {
    key: "clienta",
    header: "Clienta",
    from: "siempre",
    listSlot: "primary",
    render: (r) => r.clienta,
    text: (r) => r.clienta,
  },
  {
    key: "hora",
    header: "Hora",
    from: "siempre",
    listSlot: "secondary",
    render: (r) => r.hora,
    text: (r) => r.hora,
  },
  {
    key: "tecnica",
    header: "Profesional",
    from: "md",
    listSlot: "secondary",
    render: (r) => r.tecnica,
    text: (r) => r.tecnica,
  },
  {
    key: "servicio",
    header: "Servicio",
    from: "lg",
    listSlot: "secondary",
    render: (r) => r.servicio,
    text: (r) => r.servicio,
  },
  {
    key: "total",
    header: "Total",
    from: "md",
    numeric: true,
    listSlot: "trailing",
    render: (r) => r.total,
    text: (r) => r.total,
  },
  {
    key: "estado",
    header: "Estado",
    from: "md",
    listSlot: "trailing",
    render: (r) => r.estado,
    text: (r) => r.estado,
  },
  {
    key: "notas",
    header: "Notas",
    from: "lg",
    listSlot: "oculto",
    render: () => "…",
    text: () => "…",
  },
];

const row: Cita = {
  id: "1",
  clienta: "Marcela Ríos",
  hora: "2:30 p. m.",
  tecnica: "Lina",
  servicio: "Acrílicas esculpidas",
  total: "$ 180.000",
  estado: "Confirmada",
};

describe("visibleColumns", () => {
  it("a 390 px no hay tabla: la respuesta es ninguna columna", () => {
    // Devolver las columnas `siempre` invitaría a renderizar una tabla de dos
    // columnas y llamarla responsive, que es exactamente lo que el plan
    // prohíbe: a ese ancho la forma es la lista de dos líneas.
    expect(visibleColumns(columns, "sm")).toEqual([]);
  });

  it("a 768 px salen las prioritarias, no todas", () => {
    expect(visibleColumns(columns, "md").map((c) => c.key)).toEqual([
      "clienta",
      "hora",
      "tecnica",
      "total",
      "estado",
    ]);
  });

  it("a 1024 px sale la tabla completa", () => {
    expect(visibleColumns(columns, "lg").map((c) => c.key)).toEqual(
      columns.map((c) => c.key),
    );
  });

  it("una columna sin `from` se considera de la tabla completa", () => {
    // El default conservador: una columna nueva no se cuela en el celular sin
    // que alguien lo decida.
    const cols: Column<Cita>[] = [{ key: "x", header: "X", render: () => "x" }];
    expect(visibleColumns(cols, "md")).toEqual([]);
    expect(visibleColumns(cols, "lg")).toHaveLength(1);
  });
});

describe("listShape", () => {
  it("reparte la fila entre las dos líneas y la columna de la derecha", () => {
    const s = listShape(columns);
    expect(s.primary?.key).toBe("clienta");
    expect(s.secondary.map((c) => c.key)).toEqual(["hora", "tecnica", "servicio"]);
    expect(s.trailing.map((c) => c.key)).toEqual(["total", "estado"]);
  });

  it("sin `primary` declarada toma la primera columna", () => {
    const cols = columns.map((c) =>
      c.key === "clienta" ? { ...c, listSlot: undefined } : c,
    );
    expect(listShape(cols).primary?.key).toBe("clienta");
  });

  it("corta en dos las columnas de la derecha", () => {
    // Con tres, en 390 px el nombre de la clienta se recorta a la mitad y la
    // fila deja de servir para identificarla.
    const cols: Column<Cita>[] = [
      ...columns,
      {
        key: "extra",
        header: "Extra",
        listSlot: "trailing",
        render: () => "x",
        text: () => "x",
      },
    ];
    expect(listShape(cols).trailing).toHaveLength(2);
  });

  it("las `oculto` no aparecen en ninguna de las tres ranuras", () => {
    const s = listShape(columns);
    const used = [s.primary, ...s.secondary, ...s.trailing].map((c) => c?.key);
    expect(used).not.toContain("notas");
  });

  it("no revienta con una tabla sin columnas", () => {
    const s = listShape<Cita>([]);
    expect(s.primary).toBeNull();
    expect(s.secondary).toEqual([]);
    expect(s.trailing).toEqual([]);
  });
});

describe("secondaryLine", () => {
  it("arma la segunda línea con el separador de punto medio", () => {
    expect(secondaryLine(listShape(columns), row)).toBe(
      "2:30 p. m. · Lina · Acrílicas esculpidas",
    );
  });

  it("se salta los campos vacíos en vez de dejar separadores colgando", () => {
    expect(secondaryLine(listShape(columns), { ...row, tecnica: "" })).toBe(
      "2:30 p. m. · Acrílicas esculpidas",
    );
  });

  it("una columna sin `text` no aporta a la línea", () => {
    const cols = columns.map((c) =>
      c.key === "hora" ? { ...c, text: undefined } : c,
    );
    expect(secondaryLine(listShape(cols), row)).toBe("Lina · Acrílicas esculpidas");
  });
});
