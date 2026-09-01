import { describe, expect, it } from "vitest";

import { migrationChecksum } from "./migrate";
import { EXPECTED_TABLES, MIGRATIONS } from "./migrations";

/**
 * Lo que se puede afirmar del set **sin** una base de datos.
 *
 * Estos corren siempre: son las reglas del set (forward-only, ids únicos y
 * ordenados, nada destructivo) y no dependen de Docker. Que las migraciones
 * realmente apliquen es otro archivo, y ese sí necesita un MySQL.
 */

const ALL_SQL = MIGRATIONS.flatMap((m) => m.statements).join("\n");

describe("el set de migraciones", () => {
  it("tiene ids únicos, y el array está en orden", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("numera cada migración con tres dígitos", () => {
    // El prefijo numérico es lo que hace que el orden del array y el orden de
    // los archivos en el disco coincidan. Con dos dígitos, la décima migración
    // se ordenaría antes que la segunda.
    for (const m of MIGRATIONS) {
      expect(m.id).toMatch(/^\d{3}-[a-z0-9-]+$/);
    }
  });

  it("no contiene una sola sentencia destructiva", () => {
    // Forward-only no es una intención: es esta aserción. `gbs_admin` es el
    // libro de caja del estudio y no se puede reconstruir desde ninguna otra
    // fuente, así que un DROP acá no es un riesgo aceptable ni siquiera "por
    // si se necesita".
    expect(ALL_SQL).not.toMatch(/\bDROP\b/i);
    expect(ALL_SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(ALL_SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("no toca ningún esquema fuera de gbs_admin", () => {
    // El esquema vive en `mysql-transversal`, un MySQL 8 compartido con otras
    // aplicaciones. Los grants son por esquema, y una migración que nombre otro
    // esquema o cree un usuario fallaría en producción por falta de privilegios
    // — en el mejor caso. El usuario de solo lectura sobre `easyappointments`
    // es un paso de operación documentado en `client.ts`, no código.
    expect(ALL_SQL).not.toMatch(/easyappointments/i);
    expect(ALL_SQL).not.toMatch(/\bCREATE\s+USER\b/i);
    expect(ALL_SQL).not.toMatch(/\bGRANT\b/i);
    expect(ALL_SQL).not.toMatch(/\bCREATE\s+(SCHEMA|DATABASE)\b/i);
  });

  it("crea todas sus tablas con IF NOT EXISTS", () => {
    // Es la mitad de la idempotencia. La otra mitad es que las siembras usen
    // ON DUPLICATE KEY.
    const creates = ALL_SQL.match(/CREATE\s+TABLE[^(]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create).toMatch(/IF\s+NOT\s+EXISTS/i);
    }
  });

  it("declara los índices dentro del CREATE TABLE", () => {
    // MySQL 8 no tiene `CREATE INDEX IF NOT EXISTS`: un índice declarado afuera
    // haría fallar la segunda corrida de una migración que quedó a medias.
    expect(ALL_SQL).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
  });

  it("no usa DECIMAL ni FLOAT para nada", () => {
    // El dinero son pesos enteros: Colombia no tiene centavos. Un DECIMAL con
    // escala invita a que alguien guarde medio peso y a que el cierre del día
    // no cuadre por un redondeo que nadie pidió. Si algún día hace falta
    // escala, será una migración explícita.
    expect(ALL_SQL).not.toMatch(/\bDECIMAL\b/i);
    expect(ALL_SQL).not.toMatch(/\bFLOAT\b/i);
    expect(ALL_SQL).not.toMatch(/\bDOUBLE\b/i);
  });

  it("cubre exactamente el inventario de tablas esperado", () => {
    const created = (ALL_SQL.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?(\w+)`?/gi) ?? [])
      .map((s) => s.replace(/.*?`?(\w+)`?$/, "$1"))
      .sort();
    // `schema_migration` lo crea el runner, no una migración del set.
    const expected = EXPECTED_TABLES.filter((t) => t !== "schema_migration").sort();
    expect(created).toEqual(expected);
  });
});

describe("migrationChecksum", () => {
  it("ignora la reindentación", () => {
    // Un `prettier` sobre el archivo no puede tirar abajo el arranque de
    // producción: sería un falso positivo caro y la gente aprendería a
    // desactivar la verificación.
    const a = migrationChecksum({
      id: "x",
      description: "",
      statements: ["CREATE TABLE t (id INT)"],
    });
    const b = migrationChecksum({
      id: "x",
      description: "",
      statements: ["  CREATE  TABLE\n   t (id INT)  "],
    });
    expect(a).toBe(b);
  });

  it("cambia si cambia una palabra del SQL", () => {
    const a = migrationChecksum({
      id: "x",
      description: "",
      statements: ["CREATE TABLE t (id INT)"],
    });
    const b = migrationChecksum({
      id: "x",
      description: "",
      statements: ["CREATE TABLE t (id BIGINT)"],
    });
    expect(a).not.toBe(b);
  });

  it("cambia si cambia el id, con el mismo SQL", () => {
    const statements = ["CREATE TABLE t (id INT)"];
    expect(migrationChecksum({ id: "a", description: "", statements })).not.toBe(
      migrationChecksum({ id: "b", description: "", statements }),
    );
  });

  it("no depende de la descripción", () => {
    // La descripción es para humanos. Corregirle una tilde no puede hacer que
    // el runner declare corrupta una migración ya aplicada.
    const statements = ["CREATE TABLE t (id INT)"];
    expect(migrationChecksum({ id: "a", description: "uno", statements })).toBe(
      migrationChecksum({ id: "a", description: "otro", statements }),
    );
  });
});
