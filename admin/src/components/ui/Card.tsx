import type { ReactNode } from "react";

/**
 * La superficie de contenido.
 *
 * Se separa del fondo por **superficie y un filete de 1 px, no por sombra**.
 * La sombra queda reservada para lo que de verdad flota (hoja, diálogo, toast,
 * menú), y así el peso visual comunica algo: si algo tiene sombra, está encima
 * de la página y hay que atenderlo o cerrarlo.
 *
 * No hay tarjetas dentro de tarjetas. Si una sección necesita subdividirse, el
 * separador es un filete, no un segundo marco.
 */
export function Card({
  children,
  padded = true,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  padded?: boolean;
  as?: "section" | "div" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className="ui-card" {...rest}>
      {padded ? <div style={{ padding: "1rem" }}>{children}</div> : children}
    </Tag>
  );
}

/** Encabezado de tarjeta: título a la izquierda, acciones a la derecha. */
export function CardHead({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="ui-card__head">
      <h2 className="ui-card__title">{title}</h2>
      {actions}
    </header>
  );
}
