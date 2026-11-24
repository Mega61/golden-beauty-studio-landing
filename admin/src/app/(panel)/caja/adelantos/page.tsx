import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";

import { AdelantosVista } from "./AdelantosVista";
import { loadAdelantosView } from "./data";

/**
 * `/admin/caja/adelantos` — **Adelantos**: la plata que las clientas pagaron
 * antes de su cita (temporada). Se registran desde el detalle de la cita en la
 * agenda; acá se ven los que siguen por usar (lo que se le debe a las
 * clientas), los usados y los devueltos, y se registran las devoluciones.
 *
 * Cada adelanto viaja solo a Actual la noche del día en que entró
 * (`abono:<id>`), y al cobrar la cita se descuenta solo.
 *
 * `regalos:vender` (dueña y recepción), como Tarjetas regalo. Sin caché: es plata.
 */

export const metadata: Metadata = {
  title: "Adelantos · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function AdelantosPage() {
  // Como Tarjetas regalo: dueña y recepción. La técnica ve el adelanto en su cita.
  const session = await requireCapability("regalos:vender");
  const [view, canFixAfterSync] = await Promise.all([
    loadAdelantosView(),
    sessionCan("cuenta:corregir-tras-cierre"),
  ]);

  return (
    <AppShell role={navRole(session.role)} title="Adelantos">
      <AdelantosVista view={view} canFixAfterSync={canFixAfterSync} />
    </AppShell>
  );
}
