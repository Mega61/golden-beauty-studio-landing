import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { ForbiddenError, requireCapability } from "@/lib/dal";

import { Board } from "./Board";
import { loadDiagnostics } from "./data";

/**
 * `/admin/diagnostico` — el tablero que hace sobrevivible un sistema con un
 * solo dueño.
 *
 * No es un panel de métricas: es la lista de **las formas en que este sistema
 * falla en silencio**, cada una con su semáforo y su "última vez". Cinco de los
 * once renglones existen porque el plan documentó un modo de falla concreto y
 * verificado en la fuente de EA — el webhook que no reintenta, el push a Google
 * que se traga la excepción, el pull que borra sin avisar, la lista de estados
 * que es texto libre, y el respaldo del único esquema que no se puede
 * reconstruir desde ninguna otra fuente.
 *
 * Este archivo es la compuerta y la carga; el dibujo está en `Board.tsx` y la
 * evaluación —qué es verde y qué es rojo— en `checks.ts`, pura y testeada.
 */

export const metadata: Metadata = {
  title: "Diagnóstico · Panel",
  robots: { index: false, follow: false },
};

/** Nunca cacheado: un diagnóstico de hace cinco minutos no es un diagnóstico. */
export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function DiagnosticoPage() {
  let role: UserRole;

  try {
    ({ role } = await requireCapability("diagnostico:ver"));
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    return (
      <AppShell role="staff" title="Diagnóstico">
        <EmptyState
          icon="candado"
          title="Diagnóstico es de la dueña"
          body="Este tablero muestra el estado interno del sistema y no forma parte de tu trabajo del día."
        />
      </AppShell>
    );
  }

  const report = await loadDiagnostics(new Date());

  return (
    <AppShell role={navRole(role)} title="Diagnóstico">
      <Board checks={report.checks} window={report.window} />
    </AppShell>
  );
}
