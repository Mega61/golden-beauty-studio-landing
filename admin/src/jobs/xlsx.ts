import { inflateRawSync } from "node:zlib";

/**
 * Leer un `.xlsx` sin dependencias.
 *
 * ## Por qué no "guárdalo como CSV"
 *
 * Era el plan, y es un mal plan: **Excel estropea justo las dos columnas que
 * importan.** Un teléfono como `+573187050207` lo interpreta como fórmula o lo
 * pasa a notación científica, y una fecha `29/09/2026 15:00` la reescribe según
 * la configuración regional de quien la abrió — que es exactamente el error de
 * día-por-mes que después corre el histórico entero.
 *
 * Abrir el archivo original elimina esa clase de daño de raíz. La alternativa
 * era una librería, y una dependencia permanente para un script que corre tres
 * veces en la vida del estudio no se paga.
 *
 * ## Qué es un `.xlsx`, en realidad
 *
 * Un ZIP con XML adentro. Lo que hace falta leer son dos entradas:
 * `xl/sharedStrings.xml` (el diccionario de textos, porque Excel no repite una
 * cadena dos veces) y `xl/worksheets/sheet1.xml` (las celdas, que apuntan al
 * diccionario por índice). Nada más.
 *
 * Node trae `inflateRawSync`, que es el único algoritmo de compresión que un
 * ZIP de Excel usa (método 8, deflate) más el de guardar sin comprimir (método
 * 0). No hay que implementar ZIP entero: alcanza con recorrer el directorio
 * central, que está al final del archivo y dice dónde empieza cada entrada.
 *
 * ## Lo que este lector NO hace
 *
 * No entiende fórmulas (lee el último valor calculado, que es lo que un export
 * trae), ni formatos de número, ni fechas serializadas como número — un export
 * de Agenda Pro trae las fechas como texto y por eso no hace falta. Si algún día
 * llegara una fecha como número de serie de Excel, saldría como el número
 * crudo y el parser de fechas la rechazaría: **falla visible, no silenciosa**.
 */

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxError";
  }
}

/** Una entrada del ZIP, ya descomprimida. */
function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // El directorio central termina con la firma `PK\x05\x06`. Se busca desde el
  // final porque un comentario del ZIP puede venir después.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new XlsxError("El archivo no parece un .xlsx: no tiene directorio ZIP.");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map<string, Buffer>();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new XlsxError("El directorio del ZIP está corrupto.");
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    // La cabecera local repite los largos de nombre y extra, y **no siempre
    // coinciden con los del directorio central**: hay que leerlos de ahí para
    // saber dónde empiezan los datos.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    // Cualquier otro método (bzip2, lzma) no lo produce Excel. Se ignora la
    // entrada en vez de reventar: puede ser una miniatura.

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** `<t>` sueltos de un nodo, concatenados. Excel parte un texto con formato. */
function textOf(xml: string): string {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return parts.map(unescapeXml).join("");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // El `&amp;` va al final: hacerlo primero convertiría `&amp;lt;` en `<`.
    .replace(/&amp;/g, "&");
}

/** `"BC"` → 54. La columna de una referencia de celda. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * La primera hoja de un `.xlsx`, como filas de texto.
 *
 * Las celdas vacías se rellenan con `""` hasta la última columna con contenido
 * de cada fila: sin eso, una fila con la tercera columna vacía correría la
 * cuarta a la posición de la tercera, y el mapeo de columnas —que es por
 * posición— leería el servicio donde debería leer el teléfono.
 */
export function parseXlsx(buffer: Buffer): string[][] {
  const entries = readZipEntries(buffer);

  const sheetName =
    [...entries.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name)) ??
    [...entries.keys()].find((name) => /^xl\/worksheets\/.+\.xml$/.test(name));

  if (sheetName === undefined) throw new XlsxError("El .xlsx no tiene ninguna hoja.");

  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const sheetXml = entries.get(sheetName)!.toString("utf8");
  const rows: string[][] = [];

  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];

    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "A1";
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";

      let value = "";
      if (type === "s") {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        value = shared[index] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(body);
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }

      const at = columnIndex(ref);
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }

    rows.push(cells);
  }

  // Una hoja de Excel suele traer filas vacías al final: son filas que alguien
  // tocó y después borró, y cuentan como fila en el XML.
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim() === "")) {
    rows.pop();
  }

  return rows;
}

/** ¿Esto es un `.xlsx`? Por los dos primeros bytes de todo ZIP. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}
