/**
 * Un codificador de códigos QR, en modo byte y corrección **M**.
 *
 * ## Por qué escrito y no una dependencia
 *
 * El QR del enrolamiento TOTP lleva un `otpauth://` con el secreto de una
 * técnica adentro. Es la carga más sensible que este panel dibuja, y la lista
 * de dependencias por la que pasa es la superficie de ataque de ese secreto. Un
 * QR es una matriz de booleanos y un `<svg>`: cabe en un archivo, se testea de
 * punta a punta, y no se actualiza nunca más.
 *
 * ## Qué implementa y qué no
 *
 * - **Modo byte** (UTF-8) únicamente. Un `otpauth://` tiene minúsculas, `:`,
 *   `?` y `&`, así que el modo alfanumérico no aplica y elegir modo sería
 *   código sin usar.
 * - **Nivel M** de corrección (~15 %). Es el que usan las apps de
 *   autenticación, y en un QR que se escanea de una pantalla a treinta
 *   centímetros no hace falta más.
 * - **Versiones 1 a 20.** Un `otpauth://` con emisor, cuenta y parámetros anda
 *   por los 150 bytes: versión 8 o 9. Veinte deja margen de sobra y acota la
 *   tabla que hay que sostener.
 *
 * ## La tabla que hay que sostener, y cómo se verifica sola
 *
 * De la norma solo se copian dos columnas —cuántos bloques y cuántos
 * codewords de corrección por bloque en nivel M— porque no se derivan de nada.
 * El **total** de codewords por versión no se copia: se **cuenta** sobre la
 * plantilla de patrones de función que este mismo archivo dibuja. Eso convierte
 * una tabla memorizada en una consecuencia del código, y el test la compara
 * contra los valores de la norma: si el trazado de un patrón de alineación
 * estuviera corrido un módulo, el conteo no daría y el test lo diría.
 */

// ---------------------------------------------------------------------------
// GF(256)
// ---------------------------------------------------------------------------

/** Polinomio primitivo de QR: x⁸ + x⁴ + x³ + x² + 1. */
const GF_PRIMITIVE = 0x11d;

/** Multiplicación en GF(256). Sin tablas: ocho pasos y ninguna caché que envenenar. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * GF_PRIMITIVE);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** El divisor de Reed–Solomon de grado `degree`: (x−α⁰)(x−α¹)…(x−α^(d−1)). */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** El residuo: los codewords de corrección de un bloque. */
function rsRemainder(data: readonly number[], divisor: Uint8Array): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// La tabla de la norma (nivel M, versiones 1–20)
// ---------------------------------------------------------------------------

export const MAX_VERSION = 20;

/** Codewords de corrección por bloque, nivel M, índice = versión − 1. */
const ECC_PER_BLOCK_M = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
] as const;

/** Cantidad de bloques, nivel M, índice = versión − 1. */
const NUM_BLOCKS_M = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
] as const;

/** Los cinco bits de nivel de corrección en la información de formato. M = 0. */
const ECC_FORMAT_BITS_M = 0;

// ---------------------------------------------------------------------------
// La plantilla: patrones de función
// ---------------------------------------------------------------------------

export type QrMatrix = {
  /** `4·versión + 17`. */
  size: number;
  version: number;
  /** `true` = módulo oscuro. Indexado `[y][x]`. */
  modules: boolean[][];
  /** Cuál de las ocho máscaras ganó. Útil para el test y para depurar. */
  mask: number;
};

export function qrSize(version: number): number {
  return version * 4 + 17;
}

/**
 * Posiciones de los centros de los patrones de alineación.
 *
 * La norma trae una tabla; esto es la fórmula equivalente. El primero siempre
 * es 6 y el último `4v+10`; los del medio se reparten con un paso par.
 */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = version * 4 + 10; positions.length < count; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

type Grid = {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
};

function emptyGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunctionModule(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.modules[y][x] = dark;
  grid.isFunction[y][x] = true;
}

function drawFinder(grid: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)); // norma de Chebyshev
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < grid.size && y >= 0 && y < grid.size) {
        setFunctionModule(grid, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(grid: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunctionModule(
        grid,
        cx + dx,
        cy + dy,
        Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
      );
    }
  }
}

/**
 * Todo lo que no lleva datos: buscadores, separadores, tiempo, alineación, y
 * las áreas reservadas de formato y de versión.
 *
 * Las áreas reservadas se marcan como función **antes** de colocar los datos
 * aunque su contenido se escriba después: si no, el zigzag les pasaría por
 * encima y el código quedaría ilegible sin ningún síntoma en el código fuente.
 */
function drawFunctionPatterns(version: number): Grid {
  const size = qrSize(version);
  const grid = emptyGrid(size);

  // Patrones de tiempo: la fila y la columna 6, alternando.
  for (let i = 0; i < size; i += 1) {
    setFunctionModule(grid, 6, i, i % 2 === 0);
    setFunctionModule(grid, i, 6, i % 2 === 0);
  }

  // Los tres buscadores, con su separador.
  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);

  // Alineación, salvo donde chocaría con un buscador.
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      const corner =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!corner) drawAlignment(grid, positions[i], positions[j]);
    }
  }

  // Reserva de la información de formato y de versión. El contenido se escribe
  // cuando se elige la máscara.
  drawFormatBits(grid, 0);
  drawVersionBits(grid, version);

  return grid;
}

/** Los 15 bits de formato (nivel + máscara), con su BCH, en sus dos copias. */
function drawFormatBits(grid: Grid, mask: number): void {
  const data = (ECC_FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  const size = grid.size;

  // Primera copia, alrededor del buscador de arriba a la izquierda.
  for (let i = 0; i <= 5; i += 1) setFunctionModule(grid, 8, i, bit(i));
  setFunctionModule(grid, 8, 7, bit(6));
  setFunctionModule(grid, 8, 8, bit(7));
  setFunctionModule(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunctionModule(grid, 14 - i, 8, bit(i));

  // Segunda copia, repartida entre los otros dos buscadores.
  for (let i = 0; i < 8; i += 1) setFunctionModule(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunctionModule(grid, 8, size - 15 + i, bit(i));

  // El módulo oscuro. Siempre oscuro, en todas las versiones.
  setFunctionModule(grid, 8, size - 8, true);
}

/** Los 18 bits de versión, solo desde la versión 7. */
function drawVersionBits(grid: Grid, version: number): void {
  if (version < 7) return;

  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(grid, a, b, dark);
    setFunctionModule(grid, b, a, dark);
  }
}

/**
 * Codewords que caben en una versión.
 *
 * Se **cuenta** sobre la plantilla en vez de copiar la tabla de la norma. El
 * test compara el resultado contra esa tabla, así que el conteo verifica el
 * trazado y la tabla verifica el conteo.
 */
/**
 * Qué módulos son patrón de función y cuáles llevan datos.
 *
 * Exportado para el decodificador del test, que necesita recorrer el zigzag en
 * el mismo orden. No es hacer trampa: el trazado que produce este mapa está
 * verificado aparte contra la tabla de la norma en `rawCodewords()`, así que el
 * test de ida y vuelta sí ejercita lo que le toca — flujo de bits, corrección,
 * entrelazado, máscara y formato.
 */
export function functionModuleMap(version: number): boolean[][] {
  return drawFunctionPatterns(version).isFunction;
}

/** Las máscaras, para que el decodificador del test pueda deshacerlas. */
export function maskFunction(mask: number): (x: number, y: number) => boolean {
  return MASKS[mask];
}

const RAW_CODEWORDS_CACHE = new Map<number, number>();

export function rawCodewords(version: number): number {
  const cached = RAW_CODEWORDS_CACHE.get(version);
  if (cached !== undefined) return cached;

  const grid = drawFunctionPatterns(version);
  let free = 0;
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.isFunction[y][x]) free += 1;
    }
  }
  const total = Math.floor(free / 8);
  RAW_CODEWORDS_CACHE.set(version, total);
  return total;
}

/** Codewords de datos (los de corrección ya descontados) en nivel M. */
export function dataCodewords(version: number): number {
  return (
    rawCodewords(version) - ECC_PER_BLOCK_M[version - 1] * NUM_BLOCKS_M[version - 1]
  );
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

export class QrEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrEncodeError";
  }
}

/** Bits del contador de caracteres en modo byte: 8 hasta la versión 9, 16 desde la 10. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** La versión más chica en la que caben estos bytes. */
export function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewords(version) * 8;
    const neededBits = 4 + charCountBits(version) + byteLength * 8;
    if (neededBits <= capacityBits) return version;
  }
  throw new QrEncodeError(
    `El contenido no cabe en un QR de versión ${MAX_VERSION} con corrección M ` +
      `(${byteLength} bytes). Si un otpauth:// llegó a este tamaño, el problema ` +
      "es la etiqueta de la cuenta, no el codificador.",
  );
}

function bitStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // modo byte
  push(bytes.length, charCountBits(version));
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewords(version) * 8;
  // Terminador de hasta cuatro ceros, y relleno hasta el byte.
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  // Relleno alternado de la norma. No es decorativo: 0xEC/0x11 se eligieron
  // para no formar patrones que confundan al decodificador.
  const padding = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i += 1) {
    push(padding[i % 2], 8);
  }

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    codewords.push(value);
  }
  return codewords;
}

/**
 * Agrega la corrección y entrelaza los bloques.
 *
 * El entrelazado es lo que hace que una mancha en el papel dañe un poco de cada
 * bloque en vez de destruir uno entero. Los bloques cortos llevan un cero de
 * relleno para poder recorrerlos en paralelo, y ese cero se salta al escribir.
 */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = NUM_BLOCKS_M[version - 1];
  const eccLen = ECC_PER_BLOCK_M[version - 1];
  const raw = rawCodewords(version);
  const numShortBlocks = numBlocks - (raw % numBlocks);
  const shortBlockLen = Math.floor(raw / numBlocks);

  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  let k = 0;

  for (let i = 0; i < numBlocks; i += 1) {
    const length = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + length);
    k += length;
    const ecc = rsRemainder(chunk, divisor);
    const block = [...chunk];
    if (i < numShortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return result;
}

/** El zigzag de dos columnas, de abajo a la derecha hacia arriba a la izquierda. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  let i = 0;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // la columna 6 es el patrón de tiempo
    for (let vert = 0; vert < grid.size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? grid.size - 1 - vert : vert;
        if (!grid.isFunction[y][x] && i < codewords.length * 8) {
          grid.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i += 1;
        }
        // Los bits sobrantes (los "remainder bits" de la norma) quedan claros,
        // que es lo que dice la especificación.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Máscaras
// ---------------------------------------------------------------------------

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  const fn = MASKS[mask];
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.isFunction[y][x] && fn(x, y)) {
        grid.modules[y][x] = !grid.modules[y][x];
      }
    }
  }
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Las cuatro reglas de penalización de la norma. Menos es mejor. */
export function penaltyScore(modules: readonly boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const runScore = (line: readonly boolean[]): number => {
    let total = 0;
    let runLength = 1;
    for (let i = 1; i <= line.length; i += 1) {
      if (i < line.length && line[i] === line[i - 1]) {
        runLength += 1;
        continue;
      }
      if (runLength >= 5) total += PENALTY_N1 + (runLength - 5);
      runLength = 1;
    }
    return total;
  };

  const finderLike = (line: readonly boolean[]): number => {
    // 1011101 con cuatro claros a un lado. Se evalúa sobre la línea acolchada
    // con claros, que es como la norma trata los bordes.
    const padded = [false, false, false, false, ...line, false, false, false, false];
    let hits = 0;
    for (let i = 0; i + 11 <= padded.length; i += 1) {
      const w = padded.slice(i, i + 11);
      const pattern = [true, false, true, true, true, false, true];
      const isPattern = (offset: number) =>
        pattern.every((v, k) => w[offset + k] === v);
      const light4 = (offset: number) =>
        w.slice(offset, offset + 4).every((v) => v === false);
      if (isPattern(0) && light4(7)) hits += 1;
      if (light4(0) && isPattern(4)) hits += 1;
    }
    return hits * PENALTY_N3;
  };

  for (let y = 0; y < size; y += 1) {
    const row = modules[y];
    score += runScore(row) + finderLike(row);
  }
  for (let x = 0; x < size; x += 1) {
    const column = modules.map((row) => row[x]);
    score += runScore(column) + finderLike(column);
  }

  // Bloques de 2×2 del mismo tono.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = modules[y][x];
      if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
        score += PENALTY_N2;
      }
    }
  }

  // Desbalance entre oscuros y claros.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * PENALTY_N4;

  return score;
}

// ---------------------------------------------------------------------------
// La superficie pública
// ---------------------------------------------------------------------------

/**
 * Texto → matriz de módulos.
 *
 * Sin zona de silencio: la agrega quien dibuja (`QrSvg`), porque el ancho del
 * margen es decisión de presentación y meterlo acá obligaría a recortarlo para
 * cualquier otro uso.
 */
export function encodeQr(text: string, forcedMask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = addEccAndInterleave(bitStream(bytes, version), version);

  let best: { grid: Grid; mask: number; score: number } | null = null;

  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask !== undefined && mask !== forcedMask) continue;

    const grid = drawFunctionPatterns(version);
    drawCodewords(grid, codewords);
    applyMask(grid, mask);
    drawFormatBits(grid, mask);

    const score = penaltyScore(grid.modules);
    if (best === null || score < best.score) best = { grid, mask, score };
  }

  if (best === null) {
    throw new QrEncodeError(`Máscara inválida: ${String(forcedMask)}`);
  }

  return {
    size: best.grid.size,
    version,
    modules: best.grid.modules,
    mask: best.mask,
  };
}

/**
 * El secreto en base32 de un `otpauth://`, para escribirlo a mano.
 *
 * La app de autenticación siempre ofrece "no puedo escanear"; sin esta salida,
 * una cámara sucia o una pantalla con brillo bajo convierten el enrolamiento en
 * un viaje al local. **No lo genera: lo lee** del URI que ya armó el servidor
 * (`buildOtpauthUrl()` en `lib/totp.ts`), así que no hay dos lugares donde se
 * decida cómo se ve un otpauth.
 */
export function otpauthSecret(uri: string): string | null {
  const query = uri.indexOf("?");
  if (query === -1) return null;
  return new URLSearchParams(uri.slice(query + 1)).get("secret");
}
