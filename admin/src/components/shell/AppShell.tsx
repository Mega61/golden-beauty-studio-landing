import { ViewTransition, type ReactNode } from "react";
import { InstallHint } from "../pwa/InstallHint";
import { ReadOnlyBand } from "../ui/ReadOnlyBand";
import { Wordmark } from "./Wordmark";
import type { Role } from "./nav";

/**
 * La columna de contenido de una pantalla: toolbar, banda de solo lectura y
 * `<main>`.
 *
 * El marco que la rodea —barra lateral, riel, barra inferior— lo pone
 * `PanelFrame` desde el layout de `(panel)`, y no se vuelve a montar al
 * navegar. Los tres modos de navegación del contrato responsive:
 *
 * | Ancho    | Navegación                                        |
 * | -------- | ------------------------------------------------- |
 * | < 768    | barra inferior de cinco destinos + `safe-area`    |
 * | 768–1023 | riel de iconos                                    |
 * | ≥ 1024   | barra lateral con etiquetas                       |
 *
 * Es un **Server Component**, así la pantalla que se cuelgue de acá puede
 * seguir siendo `async` y traer sus datos sin pasar por un `useEffect`.
 *
 * **La transición entre pantallas vive acá.** El `<ViewTransition>` envuelve
 * el contenido con `default="none"`: anima solo cuando la pantalla entra o
 * sale (una navegación, o el esqueleto de `loading.tsx` que cede su lugar), y
 * nunca en un `router.refresh()` o en la revalidación de una Server Action,
 * que redibujan la misma pantalla. Una agenda que se desvanece cada vez que
 * otra persona guarda una cita sería ruido, y durante la transición la página
 * no recibe toques.
 *
 * La franja de solo lectura se dibuja **entre** la toolbar y el contenido, no
 * flotando: tiene que empujar la página, no taparla. Una banda fija sobre una
 * grilla con encabezados pegajosos termina escondiendo la primera hora de la
 * jornada.
 */
/**
 * Qué animación toca según el tipo de navegación. `nav-back` / `nav-forward`
 * los ponen las flechas de `DateStepper` (y el gesto de deslizar): moverse en
 * el tiempo se ve como pasar una hoja. Sin tipo, cambiar de destino es un
 * fundido que sube.
 *
 * `update` existe para el caso en que la pantalla se reutiliza (misma ruta,
 * otra fecha): sin tipo no anima, y así un `router.refresh()` sigue quieto.
 */
const VT_ENTER = { "nav-forward": "ui-vt-fwd", "nav-back": "ui-vt-back", default: "ui-vt-in" };
const VT_EXIT = { "nav-forward": "ui-vt-fwd", "nav-back": "ui-vt-back", default: "ui-vt-out" };
const VT_UPDATE = { "nav-forward": "ui-vt-fwd", "nav-back": "ui-vt-back", default: "none" };

export function AppShell({
  role,
  title,
  actions,
  back,
  readOnly,
  children,
}: {
  /**
   * El rol de quien mira. La navegación ya no sale de acá (la dibuja
   * `PanelFrame` con el rol de la sesión); se usa para decidir si la banda de
   * solo lectura ofrece "Ver Diagnóstico", que solo la dueña puede abrir.
   */
  role?: Role;
  /** Nombre de la pantalla. Va en la toolbar, en Inter — nunca en Cormorant. */
  title: string;
  /** Acciones de la pantalla: "Nueva cita", el selector de rango. */
  actions?: ReactNode;
  /**
   * Botón de volver en la toolbar, para las fichas (una clienta, una
   * profesional). Reemplaza al wordmark en el celular: es lo que el pulgar
   * busca arriba a la izquierda.
   */
  back?: ReactNode;
  /** Si EA no responde. `true` usa el texto por defecto. */
  readOnly?: boolean | { since?: string; reason?: string };
  children: ReactNode;
}) {
  const ro = readOnly === true ? {} : readOnly || null;

  return (
    <div className="ui-main">
      <header className="ui-topbar">
        {back ? (
          back
        ) : (
          /* El wordmark solo aparece acá en móvil: arriba de 768 px ya está en
             la barra lateral y repetirlo gasta la única fila de cromo que tiene
             la pantalla. */
          <span className="ui-topbar__brand" aria-hidden>
            <Wordmark compact />
          </span>
        )}
        <h1 className="ui-topbar__title">{title}</h1>
        {actions ? <div className="ui-topbar__actions">{actions}</div> : null}
      </header>

      {ro ? (
        <ReadOnlyBand
          since={ro.since}
          reason={ro.reason}
          detailsHref={role === "owner" ? "/diagnostico" : undefined}
        />
      ) : null}

      <ViewTransition enter={VT_ENTER} exit={VT_EXIT} update={VT_UPDATE} default="none">
        <main className="ui-content" id="contenido" tabIndex={-1}>
          {/* Solo en celular, una vez, y nunca dentro de la app instalada. */}
          <InstallHint />
          {children}
        </main>
      </ViewTransition>
    </div>
  );
}
