import { describe, expect, it } from "vitest";

import {
  alignmentPositions,
  chooseVersion,
  dataCodewords,
  encodeQr,
  functionModuleMap,
  maskFunction,
  MAX_VERSION,
  otpauthSecret,
  penaltyScore,
  QrEncodeError,
  qrSize,
  rawCodewords,
  type QrMatrix,
} from "./qr";

/**
 * Las dos columnas de la norma que el codificador **no** deriva, copiadas acá a
 * mano para que el test las contraste en vez de compartirlas.
 */
const ECC_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const NUM_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

/** Total de codewords por versión, tabla 1 de la ISO/IEC 18004. */
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733,
  815, 901, 991, 1085,
];

/** Capacidad en bytes (modo byte, nivel M), tabla 7 de la misma norma. */
const BYTE_CAPACITY_M = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504,
  560, 624, 666,
];

// ---------------------------------------------------------------------------
// Un decodificador, escrito aparte, para probar de ida y vuelta
// ---------------------------------------------------------------------------

class DecodeError extends Error {}

/** La forma exacta que produce `buildOtpauthUrl()` de `lib/totp.ts` (B2). */
const OTPAUTH =
  "otpauth://totp/Golden%20Beauty%20Studio:Lina%20Marcela" +
  "?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Golden+Beauty+Studio" +
  "&algorithm=SHA1&digits=6&period=30";

/** Lee los 15 bits de formato de la primera copia y verifica su BCH. */
function readFormat(m: QrMatrix): { mask: number; eccBits: number } {
  const bit = (x: number, y: number, i: number) => (m.modules[y][x] ? 1 << i : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= bit(8, i, i);
  bits |= bit(8, 7, 6);
  bits |= bit(8, 8, 7);
  bits |= bit(7, 8, 8);
  for (let i = 9; i < 15; i += 1) bits |= bit(14 - i, 8, i);

  const data = bits ^ 0x5412;
  // Propiedad independiente: el código BCH(15,5) es divisible por 0x537.
  let rem = data;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  if (rem !== 0) throw new DecodeError("La información de formato no pasa su BCH.");

  // Los cinco bits altos son el dato; los diez bajos, el BCH.
  const payload = data >>> 10;
  return { mask: payload & 0b111, eccBits: (payload >>> 3) & 0b11 };
}

function decodeQr(m: QrMatrix): string {
  const { mask, eccBits } = readFormat(m);
  if (eccBits !== 0) throw new DecodeError("El nivel de corrección no es M.");
  if (mask !== m.mask) throw new DecodeError("La máscara escrita no es la elegida.");

  const version = (m.size - 17) / 4;
  const isFunction = functionModuleMap(version);
  const unmask = maskFunction(mask);

  // Deshacer la máscara.
  const grid = m.modules.map((row, y) =>
    row.map((cell, x) => (isFunction[y][x] ? cell : cell !== unmask(x, y))),
  );

  // Recorrer el zigzag y reconstruir los codewords.
  const total = rawCodewords(version);
  const bits: number[] = [];
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!isFunction[y][x] && bits.length < total * 8) {
          bits.push(grid[y][x] ? 1 : 0);
        }
      }
    }
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }

  // Deshacer el entrelazado.
  const numBlocks = NUM_BLOCKS_M[version - 1];
  const eccLen = ECC_PER_BLOCK_M[version - 1];
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const blockLen = (j: number) => shortLen + (j < numShort ? 0 : 1);

  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let idx = 0;
  for (let i = 0; i < shortLen + 1; i += 1) {
    for (let j = 0; j < numBlocks; j += 1) {
      if (i !== shortLen - eccLen || j >= numShort) {
        if (i < blockLen(j)) blocks[j][i] = codewords[idx];
        idx += 1;
      }
    }
  }

  const data: number[] = [];
  for (let j = 0; j < numBlocks; j += 1) {
    data.push(...blocks[j].slice(0, blockLen(j) - eccLen));
  }

  // Leer la cabecera y los bytes.
  const dataBits: number[] = [];
  for (const codeword of data) {
    for (let i = 7; i >= 0; i -= 1) dataBits.push((codeword >>> i) & 1);
  }
  const take = (n: number) => dataBits.splice(0, n).reduce((a, b) => (a << 1) | b, 0);

  const mode = take(4);
  if (mode !== 0b0100) throw new DecodeError(`El modo no es byte: ${mode}`);
  const length = take(version <= 9 ? 8 : 16);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = take(8);

  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------

describe("la plantilla de patrones de función", () => {
  it("cuenta los mismos codewords que la tabla 1 de la norma, versión por versión", () => {
    // Es el test que verifica el trazado: si un patrón de alineación estuviera
    // corrido un módulo, o faltara reservar la información de versión, el
    // conteo de módulos libres no daría.
    for (let v = 1; v <= MAX_VERSION; v += 1) {
      expect(rawCodewords(v), `versión ${v}`).toBe(TOTAL_CODEWORDS[v - 1]);
    }
  });

  it("la capacidad en bytes que se deriva coincide con la tabla 7", () => {
    for (let v = 1; v <= MAX_VERSION; v += 1) {
      const countBits = v <= 9 ? 8 : 16;
      const capacity = Math.floor((dataCodewords(v) * 8 - 4 - countBits) / 8);
      expect(capacity, `versión ${v}`).toBe(BYTE_CAPACITY_M[v - 1]);
    }
  });

  it("el tamaño es 4·versión + 17", () => {
    expect(qrSize(1)).toBe(21);
    expect(qrSize(7)).toBe(45);
    expect(qrSize(20)).toBe(97);
  });

  it("coloca los patrones de alineación donde dice la norma", () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
    expect(alignmentPositions(20)).toEqual([6, 34, 62, 90]);
  });
});

describe("chooseVersion", () => {
  it("elige la versión más chica en la que cabe el contenido", () => {
    expect(chooseVersion(14)).toBe(1);
    expect(chooseVersion(15)).toBe(2);
    expect(chooseVersion(26)).toBe(2);
    expect(chooseVersion(27)).toBe(3);
    expect(chooseVersion(180)).toBe(9);
    // El salto a contador de 16 bits: 181 bytes ya no caben en la 9.
    expect(chooseVersion(181)).toBe(10);
  });

  it("lanza cuando no cabe, en vez de recortar el secreto en silencio", () => {
    expect(() => chooseVersion(BYTE_CAPACITY_M[MAX_VERSION - 1] + 1)).toThrow(
      QrEncodeError,
    );
  });
});

describe("encodeQr", () => {
  it("dibuja los tres buscadores en sus esquinas", () => {
    const m = encodeQr("hola");
    const finder = (ox: number, oy: number) => {
      for (let dy = 0; dy < 7; dy += 1) {
        for (let dx = 0; dx < 7; dx += 1) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(m.modules[oy + dy][ox + dx], `${ox},${oy} +${dx},${dy}`).toBe(
            ring !== 2,
          );
        }
      }
    };
    finder(0, 0);
    finder(m.size - 7, 0);
    finder(0, m.size - 7);
  });

  it("dibuja los patrones de tiempo alternando", () => {
    const m = encodeQr("hola");
    for (let i = 8; i < m.size - 8; i += 1) {
      expect(m.modules[6][i]).toBe(i % 2 === 0);
      expect(m.modules[i][6]).toBe(i % 2 === 0);
    }
  });

  it("deja el módulo oscuro siempre oscuro", () => {
    for (const texto of ["a", "hola mundo", "x".repeat(200)]) {
      const m = encodeQr(texto);
      expect(m.modules[m.size - 8][8]).toBe(true);
    }
  });

  it("la información de formato pasa su BCH y dice la máscara que se usó", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const m = encodeQr("golden beauty studio", mask);
      expect(m.mask).toBe(mask);
      expect(readFormat(m)).toEqual({ mask, eccBits: 0 });
    }
  });

  it("las dos copias de la información de formato dicen lo mismo", () => {
    const m = encodeQr("golden beauty studio");
    const bit = (x: number, y: number) => m.modules[y][x];
    // Los ocho primeros bits: (8,0..5),(8,7),(8,8) contra (size-1-i, 8).
    const copia1 = [
      bit(8, 0), bit(8, 1), bit(8, 2), bit(8, 3), bit(8, 4), bit(8, 5),
      bit(8, 7), bit(8, 8),
    ];
    const copia2 = Array.from({ length: 8 }, (_, i) => bit(m.size - 1 - i, 8));
    expect(copia1).toEqual(copia2);
  });

  it("elige la máscara de menor penalización cuando no se le fuerza una", () => {
    const libre = encodeQr("golden beauty studio");
    const puntajes = Array.from({ length: 8 }, (_, mask) =>
      penaltyScore(encodeQr("golden beauty studio", mask).modules),
    );
    expect(penaltyScore(libre.modules)).toBe(Math.min(...puntajes));
  });
});

describe("ida y vuelta con un decodificador independiente", () => {
  const casos = [
    "a",
    "hola",
    "GOLDEN BEAUTY STUDIO",
    "acentos: á é í ó ú ñ ü — y emoji 💅",
    "x".repeat(14), // el límite exacto de la versión 1
    "x".repeat(15), // el primero que obliga a la versión 2
    "y".repeat(180), // el límite de la versión 9, contador de 8 bits
    "z".repeat(181), // el primero con contador de 16 bits
    "w".repeat(400), // varios bloques, entrelazado de verdad
  ];

  for (const texto of casos) {
    it(`recupera ${texto.length} bytes de contenido`, () => {
      expect(decodeQr(encodeQr(texto))).toBe(texto);
    });
  }

  it("recupera un otpauth:// completo, que es el caso real", () => {
    // La forma exacta que produce `buildOtpauthUrl()` de `lib/totp.ts`.
    const uri = OTPAUTH;
    const m = encodeQr(uri);
    expect(decodeQr(m)).toBe(uri);
    // Un otpauth:// de esta forma cae en una versión chica: si esto empieza a
    // fallar es porque la etiqueta creció, no porque el codificador cambió.
    expect(m.version).toBeLessThanOrEqual(10);
  });

  it("recupera el contenido con cualquiera de las ocho máscaras", () => {
    const uri = OTPAUTH;
    for (let mask = 0; mask < 8; mask += 1) {
      expect(decodeQr(encodeQr(uri, mask)), `máscara ${mask}`).toBe(uri);
    }
  });
});

describe("otpauthSecret", () => {
  it("saca el secreto para poder escribirlo a mano cuando la cámara no ayuda", () => {
    expect(otpauthSecret(OTPAUTH)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("devuelve null si el URI no trae parámetros", () => {
    expect(otpauthSecret("otpauth://totp/GBS:Lina")).toBeNull();
    expect(otpauthSecret("otpauth://totp/GBS:Lina?issuer=GBS")).toBeNull();
  });
});
