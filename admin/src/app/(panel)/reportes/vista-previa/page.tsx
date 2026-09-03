import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";

import styles from "../charts.module.css";
import { PeriodFilter } from "../PeriodFilter";
import { parseCadence, parseDay, type Cadence } from "../period";
import { DailyReports, FortnightReports, MonthlyReports } from "../Reports";
import { previewData } from "./fixtures";

/**
 * `/admin/reportes/vista-previa` — los nueve reportes con un mes inventado.
 *
 * **Por qué existe:** la Definition of Done de D4 pide revisar la pantalla en
 * navegador a 390 / 768 / 1440, y no hay forma de hacerlo sin datos. Lo que hay
 * que ver es cómo se comporta una barra con un nombre largo, un mapa de calor
 * de cinco columnas, y un tile cuyo valor es la frase "todavía no se puede
 * medir" en vez de una cifra — nada de eso se ve en una pantalla vacía.
 *
 * **Qué no es:** un modo de demostración ni una puerta de atrás. La ruta
 * responde **404 en producción** (`NODE_ENV` lo decide en el build, así que la
 * rama no queda en el bundle) y los datos entran por el mismo borde por el que
 * entrarían los de EA: el tipo `ReportData` de `data.ts`, sin atajos. Los
 * componentes son **los mismos** que sirve `/reportes`, importados de
 * `Reports.tsx`, no una copia — una vista previa que duplica el JSX se
 * desactualiza a la primera corrección y termina validando una pantalla que no
 * es la que se despliega.
 *
 * El rol se cambia por query (`?rol=staff`), igual que en la galería de A3 y en
 * la vista previa de la agenda, para ver cómo se encoge la navegación.
 */

export const metadata = {
  title: "Reportes (vista previa) · Panel",
};

export const dynamic = "force-dynamic";

function parseRole(value: string | undefined): Role {
  return value === "staff" || value === "reception" ? value : "owner";
}

export default async function VistaPreviaReportes({
  searchParams,
}: {
  searchParams: Promise<{ rol?: string; cadencia?: string; ancla?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();

  const params = await searchParams;
  const role = parseRole(params.rol);
  const cadence: Cadence = parseCadence(params.cadencia);
  // Un mes fijo, no "hoy": una vista previa que cambia de datos cada mes deja
  // de ser comparable con la captura de la revisión anterior.
  const anchor = parseDay(params.ancla) ?? parseDay("2026-08-15")!;

  const data = previewData(cadence, anchor);

  return (
    <AppShell role={role} title="Reportes (vista previa)">
      <PeriodFilter base="/reportes/vista-previa" period={data.period} />
      <div className={styles.grid}>
        {cadence === "dia" ? <DailyReports data={data} /> : null}
        {cadence === "quincena" ? <FortnightReports data={data} /> : null}
        {cadence === "mes" ? <MonthlyReports data={data} /> : null}
      </div>
    </AppShell>
  );
}
