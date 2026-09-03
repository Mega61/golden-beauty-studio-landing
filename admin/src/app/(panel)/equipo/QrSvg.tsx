import { encodeQr } from "./qr";

/**
 * La matriz, dibujada.
 *
 * Un solo `<path>` con un rectángulo por módulo oscuro, no una malla de
 * `<rect>`: un QR de versión 9 son ~1.500 módulos oscuros, y 1.500 elementos
 * en el DOM tardan más en pintarse que en escanearse.
 *
 * Tres cosas que hacen la diferencia entre un QR que escanea y uno que no:
 *
 * - **Zona de silencio de 4 módulos.** La norma la exige y es lo primero que se
 *   olvida; sin ella, un lector estricto no encuentra los buscadores contra el
 *   borde de la tarjeta.
 * - **`shape-rendering: crispEdges`.** Sin eso el navegador antialiasea el
 *   borde de cada módulo y, en una pantalla de baja densidad, los módulos
 *   sueltos se vuelven grises.
 * - **Fondo blanco explícito, no transparente.** El panel es marfil; un QR sin
 *   fondo propio queda con contraste insuficiente para varias cámaras.
 */
export function QrSvg({
  text,
  /** Lado en píxeles CSS. El SVG escala solo; esto fija cuánto ocupa. */
  size = 224,
  title,
}: {
  text: string;
  size?: number;
  title: string;
}) {
  const matrix = encodeQr(text);
  const quiet = 4;
  const side = matrix.size + quiet * 2;

  let path = "";
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y][x]) {
        path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }
  }

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      style={{
        display: "block",
        shapeRendering: "crispEdges",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--hair)",
        maxWidth: "100%",
        height: "auto",
      }}
    >
      <title>{title}</title>
      <rect width={side} height={side} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
