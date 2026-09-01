"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../ui/Icon";
import { Wordmark } from "./Wordmark";
import { activeDestinationId, destinationsFor, type Role } from "./nav";

/**
 * Barra lateral (≥1024 px) y riel de iconos (768–1024 px).
 *
 * **Es el mismo `<nav>` en los dos modos**; por debajo de 1024 px el CSS
 * esconde las etiquetas y centra el icono. Renderizar dos `<nav>` distintos y
 * alternarlos con media queries duplicaría los destinos que recorre el
 * tabulador y haría que un lector de pantalla anunciara "Agenda" dos veces —
 * el clásico costo invisible de "hacerlo responsive" con dos árboles.
 *
 * En modo riel el nombre no desaparece del todo: viaja en `title` y en
 * `aria-label`, así que el destino nunca depende de reconocer un dibujo.
 */
export function SideNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const activeId = activeDestinationId(pathname, role);
  const items = destinationsFor(role);

  return (
    <aside className="ui-side">
      <div className="ui-side__brand">
        <Link
          href="/"
          style={{ textDecoration: "none", display: "flex", alignItems: "center" }}
        >
          <span className="ui-only-lg-inline">
            <Wordmark />
          </span>
          <span className="ui-only-md-inline">
            <Wordmark compact />
          </span>
        </Link>
      </div>

      <nav className="ui-nav" aria-label="Secciones del panel">
        {items.map((d, i) => {
          const isSep =
            i > 0 && items[i - 1].bottom !== undefined && d.bottom === undefined;
          const active = d.id === activeId;
          const content = (
            <>
              <Icon name={d.icon} size={20} className="ui-nav__icon" />
              <span className="ui-nav__label">{d.label}</span>
            </>
          );

          return (
            <div key={d.id} style={{ display: "contents" }}>
              {isSep ? <hr className="ui-nav__sep" /> : null}
              {d.external ? (
                <a
                  href={d.href}
                  className="ui-nav__item"
                  target="_blank"
                  rel="noreferrer"
                  title={`${d.label} · abre en otra pestaña`}
                  aria-label={`${d.label}, abre en otra pestaña`}
                >
                  {content}
                </a>
              ) : (
                <Link
                  href={d.href}
                  className="ui-nav__item"
                  aria-current={active ? "page" : undefined}
                  title={d.label}
                  aria-label={d.label}
                >
                  {content}
                </Link>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
