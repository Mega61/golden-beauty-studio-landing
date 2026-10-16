import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/ui";
import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import type { UserRole } from "@/db/types";
import { requireCapability, sessionCan } from "@/lib/dal";

import { loadMemberDetail } from "../data";
import { FichaProfesional } from "../FichaProfesional";

export const metadata: Metadata = {
  title: "Profesional · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function ProfesionalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("agenda:ver-todas");
  const puedeAdministrar = await sessionCan("equipo:administrar");

  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) notFound();

  let detail: Awaited<ReturnType<typeof loadMemberDetail>>;
  try {
    detail = await loadMemberDetail(Number(id));
  } catch {
    // La agenda caída no es un 404: decir "no existe" haría que alguien creara
    // de nuevo una profesional que sí está.
    return (
      <AppShell role={navRole(session.role)} title="Equipo">
        <EmptyState
          icon="alerta"
          title="No se pudo abrir la ficha"
          body="La agenda no respondió. Vuelve a intentar en un momento; no hace falta crear nada de nuevo."
        />
      </AppShell>
    );
  }

  if (detail === null) notFound();

  return (
    <AppShell role={navRole(session.role)} title="Equipo">
      <FichaProfesional detail={detail} puedeAdministrar={puedeAdministrar} />
    </AppShell>
  );
}
