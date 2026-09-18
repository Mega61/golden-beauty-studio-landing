import type { ReactNode } from "react";
import { ReadOnlyBand } from "../ui/ReadOnlyBand";
import { Wordmark } from "./Wordmark";
import { SideNav } from "./SideNav";
import { BottomBar } from "./BottomBar";
import type { Role } from "./nav";

/**
 * El shell del panel: los tres modos de navegación del contrato responsive.
 *
 * | Ancho    | Navegación                                        |
 * | -------- | ------------------------------------------------- |
 * | < 768    | barra inferior de cinco destinos + `safe-area`    |
 * | 768–1023 | riel de iconos                                    |
 * | ≥ 1024   | barra lateral con etiquetas                       |
 *
 * Es un **Server Component**: solo la navegación necesita saber la ruta actual,
 * y esa parte es cliente. Así la pantalla que se cuelgue del shell puede seguir
 * siendo `async` y traer sus datos sin pasar por un `useEffect`.
 *
 * El `<main>` tiene `id="contenido"` y arriba de todo hay un salto: en la
 * agenda, con la barra lateral y la toolbar, el tabulador atraviesa una docena
 * de controles antes de llegar a la grilla.
 *
 * La franja de solo lectura se dibuja **entre** la toolbar y el contenido, no
 * flotando: tiene que empujar la página, no taparla. Una banda fija sobre una
 * grilla con encabezados pegajosos termina escondiendo la primera hora de la
 * jornada.
 */
/**
 * La interfaz de EA **como la ve un navegador**.
 *
 * No es `EA_API_URL`: ésa es la interna con la que el panel habla por API, y en
 * producción es `http://golden-agenda/…`, que no resuelve fuera de la red de
 * Docker. Un enlace a esa URL abriría una pestaña muerta.
 *
 * Sin la variable, el destino "Avanzado (EA)" simplemente no se dibuja. Es
 * deliberado: un enlace que no lleva a ningún lado cuesta un clic descubrirlo y
 * deja la sensación de que el panel está roto.
 */
function eaPublicUrl(): string | null {
  const raw = process.env.EA_PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function AppShell({
  role,
  title,
  actions,
  readOnly,
  children,
}: {
  role: Role;
  /** Nombre de la pantalla. Va en la toolbar, en Inter — nunca en Cormorant. */
  title: string;
  /** Acciones de la pantalla: "Nueva cita", el selector de rango. */
  actions?: ReactNode;
  /** Si EA no responde. `true` usa el texto por defecto. */
  readOnly?: boolean | { since?: string; reason?: string };
  children: ReactNode;
}) {
  const ro = readOnly === true ? {} : readOnly || null;

  return (
    <div className="ui-shell">
      <a className="ui-skip" href="#contenido">
        Saltar al contenido
      </a>

      <SideNav role={role} eaUrl={eaPublicUrl()} />

      <div className="ui-main">
        <header className="ui-topbar">
          {/* El wordmark solo aparece acá en móvil: arriba de 768 px ya está en
              la barra lateral y repetirlo gasta la única fila de cromo que
              tiene la pantalla. */}
          <span className="ui-topbar__brand">
            <Wordmark compact />
          </span>
          <h1 className="ui-topbar__title">{title}</h1>
          {actions ? (
            <div style={{ display: "flex", gap: "0.5rem", flex: "none" }}>
              {actions}
            </div>
          ) : null}
        </header>

        {ro ? (
          <ReadOnlyBand
            since={ro.since}
            reason={ro.reason}
            detailsHref={role === "owner" ? "/diagnostico" : undefined}
          />
        ) : null}

        <main className="ui-content" id="contenido" tabIndex={-1}>
          {children}
        </main>
      </div>

      <BottomBar role={role} />
    </div>
  );
}
