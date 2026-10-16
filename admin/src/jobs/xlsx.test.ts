import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { looksLikeXlsx, parseXlsx, parseXlsxSheets, XlsxError } from "./xlsx";

/**
 * Un `.xlsx` mínimo armado a mano: ZIP con directorio central y nada más.
 *
 * El lector no verifica CRC, así que va en cero. Una entrada se guarda sin
 * comprimir y las demás con deflate, para cubrir los dos métodos que Excel usa.
 */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let index = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const stored = index === 0;
    const data = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
    index += 1;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const sheet = (rows: string) =>
  `<?xml version="1.0"?><worksheet><cols><col min="1" max="3"/></cols><sheetData>${rows}</sheetData></worksheet>`;

const SHARED = `<sst><si><t>ID</t></si><si><t>Método de Pago</t></si><si><t>Efectivo</t></si><si><r><t>Transferencia </t></r><r><t>Bancaria</t></r></si><si><t>Comprobante</t></si></sst>`;

describe("parseXlsx", () => {
  it("ubica cada celda por su referencia: una celda omitida no corre a sus vecinas", () => {
    // Fila 2: falta la B (Excel no escribe celdas vacías). Leer en orden
    // pondría "Efectivo" en la columna del comprobante.
    const book = zip({
      "xl/sharedStrings.xml": SHARED,
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>4</v></c><c r="C1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2"><v>501</v></c><c r="C2" t="s"><v>2</v></c></row>`,
      ),
    });
    expect(parseXlsx(book)).toEqual([
      ["ID", "Comprobante", "Método de Pago"],
      ["501", "", "Efectivo"],
    ]);
  });

  it("una celda que se cierra sola no se traga a la siguiente", () => {
    // `<c r="B2" s="1"/>` con el atributo voraz se leía como apertura y su
    // cuerpo llegaba hasta el `</c>` de C2: B2 se quedaba con el valor de C2.
    const book = zip({
      "xl/sharedStrings.xml": SHARED,
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>4</v></c><c r="C1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2"><v>502</v></c><c r="B2" s="1"/><c r="C2" t="s"><v>3</v></c></row>` +
          `<row r="3"/>` +
          `<row r="4"><c r="A4" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="C4" s="2"/></row>`,
      ),
    });
    expect(parseXlsx(book)).toEqual([
      ["ID", "Comprobante", "Método de Pago"],
      ["502", "", "Transferencia Bancaria"],
      [],
      ["a & b", "", ""],
    ]);
  });

  it("quita las filas vacías del final", () => {
    const book = zip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row><row r="2"><c r="A2" s="1"/></row>`,
      ),
    });
    expect(parseXlsx(book)).toEqual([["x"]]);
  });

  it("falla visible si no es un .xlsx o no tiene hojas", () => {
    expect(() => parseXlsx(Buffer.from("no soy un zip, soy texto plano con más de 22 bytes"))).toThrow(
      XlsxError,
    );
    expect(() => parseXlsx(zip({ "docProps/app.xml": "<x/>" }))).toThrow(XlsxError);
    expect(looksLikeXlsx(zip({ "a.xml": "<x/>" }))).toBe(true);
    expect(looksLikeXlsx(Buffer.from("ID;Fecha"))).toBe(false);
  });
});

describe("parseXlsxSheets", () => {
  it("devuelve cada hoja por su nombre visible, siguiendo workbook.xml y sus relaciones", () => {
    // Los archivos están cruzados a propósito: "Transacciones" es sheet1.xml.
    const book = zip({
      "xl/workbook.xml":
        `<workbook><sheets><sheet name="Ventas" sheetId="1" r:id="rId2"/>` +
        `<sheet name="Ítems &amp; más" sheetId="2" r:id="rId3"/>` +
        `<sheet name="Transacciones" sheetId="3" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels":
        `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>` +
        `<Relationship Id="rId9" Target="styles.xml"/></Relationships>`,
      "xl/sharedStrings.xml": SHARED,
      "xl/worksheets/sheet1.xml": sheet(`<row r="1"><c r="A1" t="s"><v>1</v></c></row>`),
      "xl/worksheets/sheet2.xml": sheet(`<row r="1"><c r="B1" t="s"><v>0</v></c></row>`),
      "xl/worksheets/sheet3.xml": sheet(""),
    });
    const sheets = parseXlsxSheets(book);
    expect([...sheets.keys()]).toEqual(["Ventas", "Ítems & más", "Transacciones"]);
    expect(sheets.get("Transacciones")).toEqual([["Método de Pago"]]);
    expect(sheets.get("Ventas")).toEqual([["", "ID"]]);
    expect(sheets.get("Ítems & más")).toEqual([]);
  });

  it("falla visible si el libro no declara ninguna hoja", () => {
    expect(() => parseXlsxSheets(zip({ "xl/workbook.xml": "<workbook/>" }))).toThrow(XlsxError);
  });
});
