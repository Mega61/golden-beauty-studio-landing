import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { ForbiddenError, requireCapability, sessionCan } from "@/lib/dal";

import { ComisionesVista } from "./ComisionesVista";
import { loadComisionesView } from "./data";

/**
 * `/admin/comisiones` — la quincena y lo que hay que pagarle a cada técnica.
 *
 * ## Tres roles, tres pantallas distintas
 *
 * - **La dueña** (`liquidacion:ver-todas` + `comisiones:administrar`) ve la
 *   quincena completa y es la única que calcula, revisa y paga.
 * - **La técnica** (`liquidacion:ver-propia`) ve **su** liquidación y la de
 *   nadie más. El filtro lo aplica el DAL y la consulta, no la pantalla:
 *   traerlas todas y esconder las ajenas al pintar es lo mismo que mandarlas al
 *   navegador.
 * - **La recepción** no ve comisiones. No es una omisión de la matriz de
 *   permisos: cuánto gana cada técnica no es parte de operar el día.
 *
 * La compuerta es `requireCapability()` —el DAL—, no que el destino no aparezca
 * en la navegación: esconder un enlace no es un permiso, porque la URL se
 * puede escribir a mano. Y las Server Actions vuelven a comprobar
 * `comisiones:administrar` por su cuenta.
 *
 * ## Sin caché
 *
 * Es la pantalla con la que se decide un pago. Una versión servida de caché
 * diría que faltan dos cierres de caja que ya se hicieron, o mostraría un total
 * de antes del último recálculo.
 */

export const metadata: Metadata = {
  title: "Comisiones · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function ComisionesPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{ quincena?: string }>;
}) {
  let session;

  try {
    session = await requireCapability("liquidacion:ver-propia");
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    return (
      <AppShell role="reception" title="Comisiones">
        <EmptyState
          icon="candado"
          title="Comisiones es de la dueña y de cada técnica"
          body="Cuánto gana cada una no forma parte de operar el día. Si necesitas algo de acá, pídeselo a la dueña."
        />
      </AppShell>
    );
  }

  const { quincena } = await searchParams;
  const verTodas = await sessionCan("liquidacion:ver-todas");
  const canAdmin = await sessionCan("comisiones:administrar");

  const view = await loadComisionesView({
    quincena,
    onlyEaProviderId: verTodas ? null : session.eaProviderId,
    scope: verTodas ? "todas" : "propia",
    canAdmin,
    // Una técnica sin `ea_provider_id` es una fila a medio configurar en
    // Equipo. Sin ese puente no hay liquidación que mostrar, y traerlas todas
    // sería justo lo contrario de lo que su rol permite.
    unlinked: !verTodas && session.eaProviderId === null,
  });

  return (
    <AppShell
      role={navRole(session.role)}
      title="Comisiones"
      readOnly={
        canAdmin
          ? undefined
          : {
              reason:
                // Sin punto final y sin "así que": `ReadOnlyBand` cierra la
                // frase por su cuenta.
                "Esta pantalla es de consulta para tu rol",
            }
      }
    >
      <ComisionesVista view={view} />
    </AppShell>
  );
}
