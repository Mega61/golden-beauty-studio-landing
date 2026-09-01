import type { IconName } from "../ui/Icon";

/**
 * El catálogo de destinos del panel.
 *
 * Vive en un archivo de datos y no dentro del componente porque tres cosas
 * distintas lo consumen —la barra lateral, la barra inferior y la hoja de
 * "Más"— y porque la matriz de roles se tiene que poder leer de un vistazo.
 *
 * **La visibilidad acá es cosmética, no seguridad.** `roles` decide qué se
 * dibuja; lo que decide qué se puede hacer es `verifySession()` en el DAL
 * (paquete B2), invocado desde cada Server Component, Action y Route Handler.
 * Una técnica que escriba la URL a mano tiene que rebotar en el servidor, no
 * en este arreglo.
 */

export type Role = "owner" | "reception" | "staff";

export type Destination = {
  id: string;
  label: string;
  /** Sin el `basePath`: Next lo agrega solo. */
  href: string;
  icon: IconName;
  roles: readonly Role[];
  /**
   * Uno de los cuatro primeros de la barra inferior. El quinto es siempre
   * "Más", que no es un destino sino la puerta al resto.
   */
  bottom?: 1 | 2 | 3 | 4;
  /** Abre la interfaz de EA en pestaña nueva. */
  external?: boolean;
};

const ALL: readonly Role[] = ["owner", "reception", "staff"];
const NO_STAFF: readonly Role[] = ["owner", "reception"];
const ONLY_OWNER: readonly Role[] = ["owner"];

export const DESTINATIONS: readonly Destination[] = [
  {
    id: "hoy",
    label: "Hoy",
    href: "/",
    icon: "hoy",
    roles: ALL,
    bottom: 1,
  },
  {
    id: "agenda",
    label: "Agenda",
    href: "/agenda",
    icon: "agenda",
    roles: ALL,
    bottom: 2,
  },
  {
    id: "caja",
    label: "Caja",
    href: "/caja",
    icon: "caja",
    // La técnica cierra la cuenta de sus propias citas desde Hoy, pero no ve
    // los totales del día ni hace el cierre diario.
    roles: NO_STAFF,
    bottom: 3,
  },
  {
    id: "clientas",
    label: "Clientas",
    href: "/clientes",
    icon: "clientas",
    roles: NO_STAFF,
    bottom: 4,
  },
  {
    id: "comisiones",
    label: "Comisiones",
    href: "/comisiones",
    icon: "comisiones",
    // La técnica ve su propia liquidación; el filtro por profesional lo aplica
    // el DAL, no el menú.
    roles: ALL,
  },
  {
    id: "servicios",
    label: "Servicios",
    href: "/servicios",
    icon: "servicios",
    roles: NO_STAFF,
  },
  {
    id: "equipo",
    label: "Equipo",
    href: "/equipo",
    icon: "equipo",
    roles: NO_STAFF,
  },
  {
    id: "reportes",
    label: "Reportes",
    href: "/reportes",
    icon: "reportes",
    roles: ONLY_OWNER,
  },
  {
    id: "diagnostico",
    label: "Diagnóstico",
    href: "/diagnostico",
    icon: "diagnostico",
    roles: ONLY_OWNER,
  },
  {
    id: "avanzado",
    label: "Avanzado (EA)",
    href: "/avanzado",
    icon: "externo",
    roles: ONLY_OWNER,
    external: true,
  },
];

export function destinationsFor(role: Role): Destination[] {
  return DESTINATIONS.filter((d) => d.roles.includes(role));
}

/**
 * Los cinco de la barra inferior: los cuatro marcados, en orden, más "Más".
 *
 * Si un rol no alcanza a cuatro (la técnica solo ve Hoy, Agenda y Comisiones)
 * la barra se arma con los que haya. Nunca se rellena con un destino que ese
 * rol no puede abrir: cinco casillas siempre llenas es una simetría bonita que
 * termina en una pantalla de "no autorizado".
 */
export function bottomBarFor(role: Role): Destination[] {
  return destinationsFor(role)
    .filter((d) => d.bottom !== undefined)
    .sort((a, b) => (a.bottom ?? 9) - (b.bottom ?? 9))
    .slice(0, 4);
}

/** Lo que queda para la hoja de "Más". */
export function overflowFor(role: Role): Destination[] {
  const inBar = new Set(bottomBarFor(role).map((d) => d.id));
  return destinationsFor(role).filter((d) => !inBar.has(d.id));
}

/**
 * Qué destino está activo para una ruta.
 *
 * Prefijo, no igualdad: `/clientes/482` tiene que iluminar "Clientas". La raíz
 * es el caso especial —si no, `/` sería prefijo de todo— y el desempate es por
 * `href` más largo, así que `/caja/cierre` gana contra `/caja` si algún día
 * existieran los dos.
 *
 * `pathname` llega **sin** el `basePath`: `usePathname()` ya lo quita.
 */
export function activeDestinationId(
  pathname: string,
  role: Role,
): string | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  let best: Destination | null = null;
  for (const d of destinationsFor(role)) {
    if (d.external) continue;
    const match =
      d.href === "/" ? clean === "/" : clean === d.href || clean.startsWith(`${d.href}/`);
    if (match && (!best || d.href.length > best.href.length)) best = d;
  }
  return best?.id ?? null;
}
