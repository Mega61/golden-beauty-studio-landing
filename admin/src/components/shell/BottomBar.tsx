"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { Panel } from "../ui/Panel";
import { activeDestinationId, bottomBarFor, overflowFor, type Role } from "./nav";

/**
 * Barra inferior de cinco destinos, por debajo de 768 px.
 *
 * Cuatro destinos reales más "Más", que abre una hoja con el resto. Cinco es el
 * tope: con seis, en 390 px cada casilla baja de 44 px de ancho útil y la
 * recepción —de pie, con una mano, entre una clienta que llega y otra que
 * paga— empieza a errarle.
 *
 * `env(safe-area-inset-bottom)` está en el CSS de la barra: sin eso, en un
 * iPhone el indicador de gestos se come la fila de etiquetas y los tres
 * últimos milímetros del área táctil.
 *
 * "Más" es un `<button>` con `aria-expanded`, no un enlace: no navega a
 * ninguna parte, abre una hoja. Un enlace que no lleva a una URL rompe el
 * clic-medio, el "abrir en pestaña nueva" y la expectativa del lector de
 * pantalla.
 */
export function BottomBar({ role }: { role: Role }) {
  const pathname = usePathname();
  const activeId = activeDestinationId(pathname, role);
  const [openMore, setOpenMore] = useState(false);

  const main = bottomBarFor(role);
  const rest = overflowFor(role);
  const activeInRest = rest.some((d) => d.id === activeId);

  return (
    <>
      <nav className="ui-bottombar" aria-label="Navegación principal">
        {main.map((d) => (
          <Link
            key={d.id}
            href={d.href}
            className="ui-bottombar__item"
            aria-current={d.id === activeId ? "page" : undefined}
          >
            <Icon name={d.icon} size={20} />
            {d.label}
          </Link>
        ))}

        {rest.length > 0 ? (
          <button
            type="button"
            className="ui-bottombar__item"
            aria-expanded={openMore}
            aria-haspopup="dialog"
            data-current={activeInRest ? "true" : undefined}
            onClick={() => setOpenMore(true)}
          >
            <Icon name="mas" size={20} />
            Más
          </button>
        ) : null}
      </nav>

      <Panel open={openMore} onClose={() => setOpenMore(false)} title="Más">
        <ul className="ui-list" style={{ margin: "-1rem" }}>
          {rest.map((d) => (
            <li key={d.id}>
              {d.external ? (
                <a
                  href={d.href}
                  target="_blank"
                  rel="noreferrer"
                  className="ui-list__row"
                  data-interactive="true"
                  onClick={() => setOpenMore(false)}
                >
                  <Icon name={d.icon} size={20} style={{ flex: "none" }} />
                  <span className="ui-list__body">
                    <span className="ui-list__primary">{d.label}</span>
                    <span className="ui-list__secondary">
                      Abre en otra pestaña
                    </span>
                  </span>
                </a>
              ) : (
                <Link
                  href={d.href}
                  className="ui-list__row"
                  data-interactive="true"
                  aria-current={d.id === activeId ? "page" : undefined}
                  onClick={() => setOpenMore(false)}
                >
                  <Icon name={d.icon} size={20} style={{ flex: "none" }} />
                  <span className="ui-list__body">
                    <span className="ui-list__primary">{d.label}</span>
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
