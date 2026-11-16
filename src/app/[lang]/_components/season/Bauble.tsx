/**
 * Una bola de árbol en oro, colgando de su hilo. Pieza compartida por la
 * guirnalda, el adorno del nav y el del footer.
 *
 * Pura CSS (`.gbs-bauble` en globals.css): el brillo es un radial-gradient y el
 * vaivén lo pone quien la usa con `.gbs-swing`, porque cada sitio decide
 * cuándo se mece (al verse, al pasar el mouse, al tocarla).
 */
export default function Bauble({
  size = 12,
  thread = 16,
  className = "",
  style,
}: {
  /** Diámetro de la bola, en px. */
  size?: number;
  /** Largo del hilo, en px. */
  thread?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={`gbs-bauble ${className}`}
      style={
        {
          "--bauble-size": `${size}px`,
          "--bauble-thread": `${thread}px`,
          ...style,
        } as React.CSSProperties
      }
    >
      <span className="gbs-bauble-thread" />
      <span className="gbs-bauble-cap" />
      <span className="gbs-bauble-ball" />
    </span>
  );
}
