import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * El vacío enseña la interfaz.
 *
 * "Sin resultados" no le sirve a nadie. Un vacío bien escrito contesta tres
 * cosas: qué debería haber acá, por qué no hay nada, y cuál es el siguiente
 * gesto. Por eso `title` y `body` son obligatorios y `action` casi siempre
 * debería estar: la pantalla vacía es la primera que ve alguien nuevo, y es la
 * única oportunidad de explicar la herramienta sin un manual.
 *
 * Distinguir dos vacíos distintos, que se escriben distinto:
 * - **Todavía no hay nada** ("Todavía no hay citas hoy — Nueva cita"): invita.
 * - **El filtro no encontró nada** ("Ninguna clienta con «mar»"): ofrece
 *   ampliar o limpiar el filtro, no crear.
 */
export function EmptyState({
  icon = "info",
  title,
  body,
  action,
  secondary,
}: {
  icon?: IconName;
  title: string;
  body: string;
  /** El gesto que la pantalla está enseñando. */
  action?: ReactNode;
  /** Salida alternativa: limpiar el filtro, ir a otro lado. */
  secondary?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__mark" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <h3 className="ui-empty__title">{title}</h3>
      <p className="ui-empty__body">{body}</p>
      {action || secondary ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "0.375rem",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
