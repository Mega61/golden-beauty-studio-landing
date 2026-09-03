/**
 * Esqueletos: cargando con la forma del contenido, no un spinner en el centro
 * de la pantalla.
 *
 * La diferencia no es estética. Un spinner dice "espera" y nada más; un
 * esqueleto dice "van a venir tres filas con un nombre a la izquierda y un
 * monto a la derecha", y cuando llegan el ojo ya sabe dónde mirar. En una
 * pantalla que se refresca cada 30 s eso es la diferencia entre una interfaz
 * que parpadea y una que respira.
 *
 * El brillo se apaga entero con `prefers-reduced-motion` (queda el bloque
 * quieto, que sigue comunicando "acá va algo").
 */

export function Skeleton({
  width = "100%",
  height = 12,
  radius = "var(--radius-xs)",
}: {
  width?: number | string;
  height?: number | string;
  radius?: string;
}) {
  return (
    <span
      className="ui-skel"
      aria-hidden
      style={{
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        borderRadius: radius,
      }}
    />
  );
}

/**
 * Varias líneas de texto. La última sale más corta, como sale un párrafo de
 * verdad — un bloque de líneas todas iguales se lee como un placeholder de
 * maqueta, no como texto que viene en camino.
 */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      aria-hidden
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={10} width={i === lines - 1 ? "58%" : "100%"} />
      ))}
    </span>
  );
}

/** La forma de una tarjeta de KPI: rótulo corto arriba, cifra grande abajo. */
export function SkeletonStat() {
  return (
    <div className="ui-card" style={{ padding: "0.875rem 1rem" }} aria-hidden>
      <Skeleton height={10} width="45%" />
      <div style={{ height: "0.625rem" }} />
      <Skeleton height={22} width="62%" radius="var(--radius-sm)" />
    </div>
  );
}

/**
 * El contenedor que anuncia la carga. Va una sola vez por región: si cada
 * esqueleto anunciara, un dashboard con seis tarjetas diría "cargando" seis
 * veces.
 */
export function LoadingRegion({
  label = "Cargando",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="ui-sr">{label}</span>
      {children}
    </div>
  );
}
