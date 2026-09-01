import type { SVGProps } from "react";

/**
 * El set de iconos del panel.
 *
 * Dibujados, no tomados de una fuente de emoji ni de una librería: un emoji
 * cambia de forma en cada sistema operativo y no hereda el peso del trazo.
 * Todos comparten la misma retícula de 24, el mismo `stroke-width` de 1.6 y
 * remates redondos, así que a 20 px se leen como un solo alfabeto.
 *
 * Cada icono es `aria-hidden` por defecto: el nombre del destino viaja en el
 * texto de al lado o en el `aria-label` del control. Un icono no es una
 * etiqueta.
 */

export type IconName =
  | "hoy"
  | "agenda"
  | "caja"
  | "clientas"
  | "mas"
  | "cita"
  | "servicios"
  | "equipo"
  | "comisiones"
  | "reportes"
  | "diagnostico"
  | "externo"
  | "mas-signo"
  | "buscar"
  | "cerrar"
  | "chevron-izq"
  | "chevron-der"
  | "chevron-abajo"
  | "check"
  | "alerta"
  | "info"
  | "deshacer"
  | "candado"
  | "reloj";

const PATHS: Record<IconName, React.ReactNode> = {
  // Hoy: el sol sobre el mesón. La pantalla que abre la recepción.
  hoy: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  agenda: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  caja: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 15h2" />
    </>
  ),
  clientas: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14.6A5.5 5.5 0 0 1 20.5 20" />
    </>
  ),
  mas: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  cita: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  servicios: (
    <>
      <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </>
  ),
  equipo: (
    <>
      <circle cx="10" cy="8" r="3.4" />
      <path d="M3.8 20a6.2 6.2 0 0 1 12.4 0" />
      <path d="M16.5 11.5l1.6 1.6 3.2-3.2" />
    </>
  ),
  comisiones: (
    <>
      <circle cx="7.5" cy="7.5" r="2.6" />
      <circle cx="16.5" cy="16.5" r="2.6" />
      <path d="M19 5 5 19" />
    </>
  ),
  reportes: (
    <>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V6M17 20v-9" />
    </>
  ),
  diagnostico: (
    <>
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
    </>
  ),
  externo: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  "mas-signo": <path d="M12 5v14M5 12h14" />,
  buscar: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </>
  ),
  cerrar: <path d="m6 6 12 12M18 6 6 18" />,
  "chevron-izq": <path d="m14.5 5-7 7 7 7" />,
  "chevron-der": <path d="m9.5 5 7 7-7 7" />,
  "chevron-abajo": <path d="m5 9.5 7 7 7-7" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alerta: (
    <>
      <path d="M12 3.8 21 19.5H3z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5M12 7.9h.01" />
    </>
  ),
  deshacer: (
    <>
      <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
      <path d="M7.5 5 3.5 9l4 4" />
    </>
  ),
  candado: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>
  ),
  reloj: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2V12l3.2 2" />
    </>
  ),
};

export type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  /** Lado del cuadro, en px. 20 en navegación y botones, 16 en línea de texto. */
  size?: number;
  /**
   * Solo si el icono es el único contenido de un control **y** ese control no
   * trae `aria-label`. Lo normal es dejarlo vacío: el icono es decorativo y el
   * nombre lo pone el texto de al lado.
   */
  title?: string;
};

export function Icon({ name, size = 20, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
