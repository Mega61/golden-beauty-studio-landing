import { Skeleton, SkeletonStat } from "../ui/Skeleton";
import { AppShell } from "./AppShell";

/**
 * Lo que se ve mientras una pantalla trae sus datos (`loading.tsx`).
 *
 * El marco ya está en pantalla —lo pone el layout—, así que al tocar un
 * destino la respuesta es inmediata: la toolbar con el nombre nuevo y el hueco
 * con la forma de lo que viene. Esqueletos y no un spinner al centro: la
 * pantalla ya sabe que va a haber una fila de fecha y una pila de tarjetas, y
 * dibujar ese hueco evita que la página salte cuando llegan.
 *
 * Cuatro formas, que son las cuatro que tiene el panel:
 *
 * - `cards`: Hoy, Recordatorios — fecha y una pila de tarjetas.
 * - `agenda`: la barra de fecha y la grilla.
 * - `list`: Clientes, Servicios, Equipo — buscador y filas.
 * - `stats`: Caja, Comisiones, Reportes, Diagnóstico, Ajustes — cifras.
 *
 * Tres tarjetas o seis filas y no más: es lo que cabe en un celular sin
 * desplazar. Un esqueleto más largo que el contenido real es una promesa que
 * la pantalla no cumple.
 */
export function ScreenSkeleton({
  title,
  shape,
  label = "Cargando…",
}: {
  title: string;
  shape: "cards" | "agenda" | "list" | "stats";
  /** Lo que anuncia el lector de pantalla. */
  label?: string;
}) {
  return (
    <AppShell title={title}>
      <div className="ui-skelscreen" aria-busy="true" aria-live="polite">
        <span className="ui-sr">{label}</span>
        {shape === "cards" ? <Cards /> : null}
        {shape === "agenda" ? <Agenda /> : null}
        {shape === "list" ? <List /> : null}
        {shape === "stats" ? <Stats /> : null}
      </div>
    </AppShell>
  );
}

function Stepper() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <Skeleton width={44} height={44} radius="var(--radius-md)" />
      <Skeleton width="100%" height={44} radius="var(--radius-md)" />
      <Skeleton width={44} height={44} radius="var(--radius-md)" />
    </div>
  );
}

function Cards() {
  return (
    <>
      <Stepper />
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
    </>
  );
}

function Agenda() {
  return (
    <>
      <Stepper />
      <div className="ui-card" style={{ display: "grid", gap: "1px", overflow: "hidden" }}>
        <div style={{ padding: "0.75rem" }}>
          <Skeleton width="40%" height={14} />
        </div>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "3rem 1fr", gap: "0.5rem", padding: "0 0.75rem 1.5rem" }}>
            <Skeleton width="2.25rem" height={10} />
            {i === 1 || i === 3 ? (
              <Skeleton width="100%" height={56} radius="var(--radius-md)" />
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function List() {
  return (
    <>
      <Skeleton width="100%" height={44} radius="var(--radius-sm)" />
      <div className="ui-card" style={{ overflow: "hidden" }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.875rem",
              borderBottom: i < 5 ? "1px solid var(--hair)" : undefined,
            }}
          >
            <div style={{ flex: 1, display: "grid", gap: "0.375rem" }}>
              <Skeleton width={`${55 - (i % 3) * 10}%`} height={14} />
              <Skeleton width="35%" height={10} />
            </div>
            <Skeleton width={20} height={20} radius="var(--radius-sm)" />
          </div>
        ))}
      </div>
    </>
  );
}

function Stats() {
  return (
    <>
      <Stepper />
      <div className="ui-card" style={{ padding: "1rem", display: "grid", gap: "1rem" }}>
        <SkeletonStat />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
        </div>
      </div>
      <div className="ui-card" style={{ padding: "1rem", display: "grid", gap: "0.75rem" }}>
        <Skeleton width="35%" height={14} />
        <Skeleton width="100%" height={12} />
        <Skeleton width="80%" height={12} />
      </div>
    </>
  );
}
