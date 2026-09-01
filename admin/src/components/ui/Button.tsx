import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Botón del panel, con los siete estados: default, hover, focus, active,
 * disabled, loading y error.
 *
 * Dos decisiones que valen para todo el kit:
 *
 * - **`loading` no encoge el botón.** El contenido se vuelve invisible pero
 *   sigue ocupando su ancho, y el spinner se dibuja encima. Un botón que se
 *   angosta al enviar mueve toda la fila y hace perder el sitio a quien estaba
 *   mirando.
 * - **`loading` implica `disabled`.** Un doble envío en la caja crea dos
 *   cuentas, no una. El `aria-disabled` acompaña al `disabled` real para que el
 *   lector de pantalla lo anuncie en vez de encontrarse un control mudo.
 *
 * El estado `error` no es un color de botón: un botón rojo permanente no
 * comunica nada. Cuando una acción falla lo que aparece es el toast de error;
 * `invalid` acá solo marca el control con `aria-invalid` para el caso del botón
 * que dispara un formulario con errores.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

type Common = {
  variant?: ButtonVariant;
  /** Tamaño compacto para acciones dentro de una fila de tabla. */
  size?: "md" | "sm";
  /** Icono antes del texto. */
  icon?: IconName;
  /** Ocupa todo el ancho: la forma normal en el pie de una hoja móvil. */
  block?: boolean;
  children?: ReactNode;
};

export type ButtonProps = Common &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
    loading?: boolean;
    /** Qué se anuncia mientras carga. Por defecto, "Procesando". */
    loadingLabel?: string;
  };

function classes(
  variant: ButtonVariant,
  size: "md" | "sm",
  block: boolean,
  iconOnly: boolean,
) {
  return [
    "ui-btn",
    `ui-btn--${variant}`,
    size === "sm" && "ui-btn--sm",
    block && "ui-btn--block",
    iconOnly && "ui-btn--icon",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  block = false,
  loading = false,
  loadingLabel = "Procesando",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const iconOnly = Boolean(icon) && children == null;
  const isOff = Boolean(disabled) || loading;

  return (
    <button
      type="button"
      {...rest}
      className={classes(variant, size, block, iconOnly)}
      disabled={isOff}
      aria-disabled={isOff || undefined}
      aria-busy={loading || undefined}
      data-loading={loading ? "true" : undefined}
    >
      {loading ? (
        <>
          {/* El contenido real se queda reservando el ancho. */}
          <span aria-hidden style={{ visibility: "hidden", display: "contents" }}>
            {icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
            {children}
          </span>
          <span
            className="ui-spinner"
            style={{ position: "absolute", insetInlineStart: "50%", marginInlineStart: "-0.5em" }}
            aria-hidden
          />
          <span className="ui-sr">{loadingLabel}</span>
        </>
      ) : (
        <>
          {icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
          {children}
        </>
      )}
    </button>
  );
}

export type ButtonLinkProps = Common &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className">;

/**
 * La misma forma, pero navega. Existe para que "Ver la cita" y "Guardar" se
 * vean idénticos: si el mismo gesto visual a veces navega y a veces actúa, la
 * usuaria deja de confiar en el gesto.
 */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  block = false,
  children,
  ...rest
}: ButtonLinkProps) {
  const iconOnly = Boolean(icon) && children == null;
  return (
    <a {...rest} className={classes(variant, size, block, iconOnly)}>
      {icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
      {children}
    </a>
  );
}
