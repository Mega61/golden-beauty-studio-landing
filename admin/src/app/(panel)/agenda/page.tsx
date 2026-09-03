import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { datesFor, parseAnchor, parseRangeMode } from "@/components/calendar";
import type { UserRole } from "@/db/types";
import { AgendaClient } from "./AgendaClient";
import { loadAgenda, todayInStudio } from "./data";

/**
 * `/admin/agenda` — la pantalla donde el estudio pasa el día.
 *
 * Es un Server Component: pide los datos, arma el shell y le entrega el rango
 * ya cargado al cliente, que a partir de ahí se refresca solo. Sin esto, la
 * primera pintura sería un esqueleto y un `useEffect`, y la agenda es lo primero
 * que alguien abre a las ocho de la mañana.
 *
 * ## Dos cosas que este archivo tuvo que resolver y conviene no deshacer
 *
 * - **El `AppShell` se monta acá, no en un layout de `(panel)`.** Ese layout
 *   todavía no existe —lo trae otro paquete de la Ola C— y este no lo puede
 *   crear: no le pertenece. El día que aparezca, el `AppShell` sube ahí y de
 *   este archivo se va el envoltorio; lo de adentro no cambia.
 * - **`admin` no es `reception`.** El rol de la base (`UserRole` de A2) es
 *   `owner | admin | staff`; el de la navegación (A3) es
 *   `owner | reception | staff`. Son la misma persona con dos nombres, y la
 *   traducción vive acá porque ninguno de los dos archivos es de este paquete.
 *   Está reportado: lo natural es que `nav.ts` hable `UserRole`.
 */

export const metadata = {
  title: "Agenda · Panel",
};

/** El panel siempre quiere el estado de ahora; una agenda cacheada miente. */
export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. Ver la cabecera. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function AgendaPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{ rango?: string; dia?: string }>;
}) {
  const params = await searchParams;
  const today = todayInStudio();
  const mode = parseRangeMode(params.rango);
  const anchor = parseAnchor(params.dia, today);
  const dates = datesFor(mode, anchor);

  // `loadAgenda()` llama al DAL: sin sesión, esto redirige al login antes de
  // tocar EA.
  const result = await loadAgenda(dates);

  const role = navRole(result.session.role);

  return (
    <AppShell
      role={role}
      title="Agenda"
      readOnly={result.ok ? undefined : { reason: result.reason }}
    >
      <AgendaClient
        initial={
          result.ok
            ? result.data
            : {
                // EA caído no es una pantalla de error: el panel entra en solo
                // lectura y dibuja la grilla vacía con la banda de aviso arriba
                // (§ Estados que no son el estado feliz). Los puestos vienen de
                // `gbs_admin`, que sí respondió.
                providers: [],
                appointments: [],
                unavailabilities: [],
                blockedPeriods: [],
                meta: {},
                services: [],
                capacities: [],
                stations: result.stations,
                fetchedAt: new Date().toISOString(),
              }
        }
        mode={mode}
        anchor={anchor}
        today={today}
        eaFailure={result.ok ? null : result.reason}
        // Una técnica solo puede bloquearse a sí misma; el formulario le fija la
        // profesional y el DAL lo vuelve a comprobar en la acción.
        ownProviderId={result.session.role === "staff" ? result.session.eaProviderId : null}
        // Escribir la agenda no tiene capacidad propia en la matriz de B2: el
        // alcance de una técnica se decide por columna, con
        // `requireOwnProvider()`, en cada acción. Lo que sí la deja sin escribir
        // es una fila de Equipo a medio configurar — `staff` sin
        // `ea_provider_id` no es dueña de ninguna columna.
        canWrite={result.session.role !== "staff" || result.session.eaProviderId !== null}
      />
    </AppShell>
  );
}
