import { AppShell } from "@/components/shell";
import { Skeleton } from "@/components/ui";

/**
 * Lo que se ve mientras "Hoy" trae sus datos.
 *
 * Esqueletos con la forma del contenido, no un spinner en el centro: la
 * pantalla ya sabe que va a haber una fila de fecha y una pila de tarjetas, y
 * dibujar ese hueco evita que la página salte cuando llegan.
 *
 * El shell se repite acá porque el layout de `(panel)` no lo pone —cada
 * pantalla trae el suyo, con su título y sus acciones—, y sin él la carga se
 * vería como una página en blanco sin navegación y con la barra inferior
 * apareciendo de golpe medio segundo después.
 *
 * Tres tarjetas y no ocho: es lo que cabe en un celular sin desplazar. Un
 * esqueleto más largo que el contenido real es una promesa que la pantalla no
 * cumple.
 */
export default function Loading() {
  return (
    <AppShell role="owner" title="Hoy">
      <div style={{ display: "grid", gap: "1rem" }} aria-busy="true" aria-live="polite">
        <span className="ui-sr">Cargando las citas de hoy…</span>

        <Skeleton width="12rem" height={14} />

        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="ui-card"
            style={{ display: "grid", gap: "0.625rem", padding: "0.875rem" }}
          >
            <Skeleton width="9rem" height={12} />
            <Skeleton width="60%" height={18} />
            <Skeleton width="45%" height={14} />
            <Skeleton width="100%" height={44} radius="var(--radius-md)" />
          </div>
        ))}
      </div>
    </AppShell>
  );
}
