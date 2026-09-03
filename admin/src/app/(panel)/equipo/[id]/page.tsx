import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/ui";
import { requireCapability, sessionCan } from "@/lib/dal";

import { loadMemberDetail } from "../data";
import { FichaProfesional } from "../FichaProfesional";

export const metadata: Metadata = {
  title: "Profesional · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ProfesionalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCapability("agenda:ver-todas");
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
      <EmptyState
        icon="alerta"
        title="No se pudo abrir la ficha"
        body="La agenda no respondió. Vuelve a intentar en un momento; no hace falta crear nada de nuevo."
      />
    );
  }

  if (detail === null) notFound();

  return <FichaProfesional detail={detail} puedeAdministrar={puedeAdministrar} />;
}
