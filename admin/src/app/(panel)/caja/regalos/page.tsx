import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";

import { RegalosVista } from "./RegalosVista";
import { loadRegalosView } from "./data";

/**
 * `/admin/caja/regalos` — **Tarjetas regalo**: confirmar el pago de los
 * pedidos de la página, vender una en el estudio y ver las activas y usadas.
 *
 * Vive bajo Caja porque es plata: una venta confirmada acá es ingreso del día
 * del pago y viaja sola a Actual cada noche (`bono:<código>`). Los montos, el
 * diseño y la administración completa de las tarjetas están en Stampee; usar
 * una tarjeta es cobrar la cuenta, desde Hoy.
 *
 * `regalos:vender` (dueña y recepción). Sin caché: es plata.
 */

export const metadata: Metadata = {
  title: "Tarjetas regalo · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function RegalosPage() {
  const session = await requireCapability("regalos:vender");
  const [view, canFixAfterSync] = await Promise.all([
    loadRegalosView(),
    sessionCan("cuenta:corregir-tras-cierre"),
  ]);

  return (
    <AppShell role={navRole(session.role)} title="Tarjetas regalo">
      <RegalosVista view={view} canFixAfterSync={canFixAfterSync} />
    </AppShell>
  );
}
