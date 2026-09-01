/**
 * El wordmark. **Uno de los dos únicos lugares del panel donde aparece
 * Cormorant** — el otro es la pantalla de login. En etiquetas, botones,
 * encabezados de tabla o cifras, jamás: una serif display en una celda de datos
 * es el tell de "landing disfrazada de herramienta".
 *
 * En el riel (768–1024 px) no cabe el nombre completo, así que queda la
 * inicial. Sigue siendo Cormorant y sigue siendo marca; lo que se pierde es
 * texto, y el nombre completo se conserva para el lector de pantalla.
 */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className="ui-wordmark"
      style={{ fontSize: compact ? "1.25rem" : "1.125rem" }}
    >
      <span aria-hidden>{compact ? "G" : "Golden Beauty"}</span>
      <span className="ui-sr">Golden Beauty Studio · Panel</span>
    </span>
  );
}
