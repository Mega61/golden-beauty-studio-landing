/**
 * Razón de contraste de WCAG 2.x entre dos colores hex.
 *
 * Existe para que las afirmaciones de contraste del sistema de diseño sean
 * **verificables por un test** en vez de por un comentario. "Se ve bien" no es
 * un criterio; 4.5:1 sí. `status.test.ts` recalcula cada par de la paleta de
 * estados desde los hex y falla si alguno cae por debajo del piso.
 *
 * Es la misma fórmula que usa el validador de la skill `dataviz`, copiada acá
 * en veinte líneas para no arrastrar una dependencia por una función pura.
 */

function channels(hex: string): [number, number, number] {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`hex inválido: ${hex}`);
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** Luminancia relativa, 0 (negro) a 1 (blanco). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razón de contraste, de 1 (idénticos) a 21 (negro sobre blanco). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

/** Los dos pisos que este panel se impuso. */
export const CONTRAST_FLOOR = {
  /** Texto de cuerpo y placeholders. */
  bodyText: 4.5,
  /** Texto grande (≥24 px, o ≥19 px en negrita) y componentes de interfaz. */
  largeText: 3,
  /** Anillo de foco, contra marfil **y** contra crema. */
  focusRing: 3,
} as const;
