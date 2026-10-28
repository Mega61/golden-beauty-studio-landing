import type { ReactNode } from "react";
import { SideNav } from "./SideNav";
import { BottomBar } from "./BottomBar";
import type { Role } from "./nav";

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

/**
 * El marco que **no** cambia al navegar: barra lateral, riel y barra inferior.
 *
 * Vive en el layout de `(panel)` y no en cada pantalla. Cuando el marco lo
 * dibujaba cada `page.tsx`, tocar "Agenda" en la barra inferior desmontaba la
 * barra entera y la volvía a montar con la página nueva: medio segundo sin
 * respuesta al toque, y el "Más" que se cerraba de golpe. En el layout la
 * navegación se queda quieta y lo único que cambia es la columna de contenido
 * (`AppShell`, que sigue siendo de cada pantalla con su título y sus
 * acciones).
 *
 * Es un **Server Component**: solo la navegación necesita saber la ruta actual,
 * y esa parte es cliente.
 *
 * El salto al contenido va arriba de todo: en la agenda, con la barra lateral y
 * la toolbar, el tabulador atraviesa una docena de controles antes de llegar a
 * la grilla.
 */
export function PanelFrame({ role, children }: { role: Role; children: ReactNode }) {
  return (
    <div className="ui-shell">
      <a className="ui-skip" href="#contenido">
        Saltar al contenido
      </a>
      <SideNav role={role} eaUrl={eaPublicUrl()} />
      {children}
      <BottomBar role={role} />
    </div>
  );
}
