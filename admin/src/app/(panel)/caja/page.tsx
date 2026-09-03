import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import type { UserRole } from "@/db/types";
import { requireCapability } from "@/lib/dal";

import { CajaVista } from "./CajaVista";
import { loadCajaView } from "./data";

/**
 * `/admin/caja` — el día completo y su cierre.
 *
 * ## Una técnica no llega acá
 *
 * `caja:ver` es de la dueña y de la recepción. La técnica cierra la cuenta de
 * sus propias citas desde Hoy, pero no ve los totales del día, ni las cuentas
 * de las demás, ni hace el cierre. La compuerta es `requireCapability()` —el
 * DAL— y no que el destino "Caja" no aparezca en su navegación: esconder un
 * enlace no es un permiso, porque la URL se puede escribir a mano.
 *
 * `caja:cerrar-dia` se comprueba aparte, dentro de las Server Actions. Que el
 * botón se dibuje es cosmética; que la escritura ocurra, no.
 *
 * ## El shell se monta acá
 *
 * El layout de `(panel)` garantiza que haya sesión y nada más: cada pantalla
 * aporta su `title` y su banda de solo lectura con su propio `<AppShell>`.
 *
 * ## Sin caché
 *
 * Es la pantalla con la que se decide si la caja cuadra. Una versión servida de
 * caché diría que faltan tres cuentas que ya se cerraron, o al revés.
 */

export const metadata: Metadata = {
  title: "Caja · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function CajaPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{ fecha?: string }>;
}) {
  const session = await requireCapability("caja:ver");
  const { fecha } = await searchParams;

  const view = await loadCajaView(fecha);

  // EA sin responder no es una pantalla de error: la plata está en `gbs_admin`,
  // que sí contestó, y las cuentas del día se pueden ver igual. Lo que no se
  // puede es cerrar — sin la agenda no hay forma de saber qué citas hubo — y
  // eso lo dice el bloqueo que trae la revisión.
  const sinAgenda = view.review.blockers.length > 0 && view.dayClose === null;

  return (
    <AppShell
      role={navRole(session.role)}
      title="Caja"
      readOnly={
        sinAgenda
          ? {
              reason:
                // Sin punto final y sin "así que": `ReadOnlyBand` cierra la
                // frase por su cuenta con ", así que por ahora no se puede
                // crear ni modificar nada".
                "No se pudo leer la agenda y el cierre del día queda bloqueado",
            }
          : undefined
      }
    >
      <CajaVista view={view} />
    </AppShell>
  );
}
