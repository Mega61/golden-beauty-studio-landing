import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { ConflictReview } from "@/components/calendar";
import { parseAnchor, parseRangeMode } from "@/components/calendar";
import { instantToEaDate } from "@/lib/ea/datetime";
import { AgendaClient } from "../AgendaClient";
import { previewConflicts, previewData } from "./fixtures";

/**
 * `/admin/agenda/vista-previa` — la agenda con un día inventado.
 *
 * **Por qué existe:** la Definition of Done de este paquete pide revisar la
 * pantalla en navegador a 390 / 768 / 1440, y no hay forma de hacerlo sin datos.
 * Montar Easy!Appointments con su asistente de instalación, tres técnicas y una
 * tarde de citas para comprobar que un bloque de quince minutos se puede tocar
 * es una hora de trabajo que no prueba nada del panel.
 *
 * **Qué no es:** un modo de demostración ni una puerta de atrás. La ruta
 * responde **404 en producción** —`NODE_ENV` lo decide en el build, así que la
 * rama ni siquiera queda en el bundle— y los datos entran como props por el
 * mismo borde por el que entrarían los de EA. Nada acá toca el DAL, ni MySQL, ni
 * la API: las acciones de guardado existen y fallan, que es también algo que
 * conviene poder mirar.
 *
 * El rol se cambia por query (`?rol=staff`), igual que en la galería de A3, para
 * ver cómo se encoge la navegación.
 */

export const metadata = {
  title: "Agenda (vista previa) · Panel",
};

export const dynamic = "force-dynamic";

function parseRole(value: string | undefined): Role {
  return value === "staff" || value === "reception" ? value : "owner";
}

export default async function VistaPreviaPage({
  searchParams,
}: {
  searchParams: Promise<{ rol?: string; rango?: string; dia?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const today = instantToEaDate(new Date());
  const role = parseRole(params.rol);
  const mode = parseRangeMode(params.rango);
  const anchor = parseAnchor(params.dia, today);

  const data = previewData(anchor);
  const providers = data.providers.map((p) => ({ id: p.id, name: p.name }));

  return (
    <AppShell role={role} title="Agenda (vista previa)">
      <AgendaClient
        initial={data}
        mode={mode}
        anchor={anchor}
        today={today}
        eaFailure={null}
        ownProviderId={role === "staff" ? 1 : null}
        canWrite
      />

      {/* Lo único que la vista previa no puede producir sola: el reporte de
          choques lo arma el servidor al enviar. Se muestra suelto para poder
          revisar la parte de la pantalla que más importa —la que dice con qué
          choca— sin EA levantado. */}
      <details style={{ marginTop: "1rem" }}>
        <summary
          style={{
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            padding: "0.5rem 0",
          }}
        >
          Muestra: diálogo de choques
        </summary>
        <div style={{ maxWidth: "26rem", marginTop: "0.5rem" }}>
          <ConflictReview
            report={previewConflicts(anchor)}
            providers={providers}
            meta={data.meta}
          />
        </div>
      </details>
    </AppShell>
  );
}
