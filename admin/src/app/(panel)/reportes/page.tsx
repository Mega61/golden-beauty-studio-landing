import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { instantToEaDate } from "@/lib/ea";

import styles from "./charts.module.css";
import { loadReports } from "./data";
import { PeriodFilter } from "./PeriodFilter";
import { resolvePeriod } from "./period";
import { DailyReports, FortnightReports, MonthlyReports } from "./Reports";

/**
 * `/admin/reportes` — los nueve reportes del plan, agrupados por cadencia.
 *
 * ## Por qué la cadencia elige qué se dibuja
 *
 * § El set de reportes propio le pone cadencia a cada reporte: diario,
 * quincenal, mensual. No es metadato — es el rango en el que la cifra
 * significa algo. Y la regla de composición de `dataviz` es que **una fila de
 * filtros scopea todo lo que está debajo**. Las dos juntas dan esta pantalla:
 * un selector de cadencia, un rango, y solo los reportes de esa cadencia. La
 * alternativa —nueve tarjetas con nueve rangos— sería nueve tableros pegados,
 * con cifras que no se pueden sumar entre sí.
 *
 * ## Ningún cálculo vive acá
 *
 * Este archivo pide datos, llama a `aggregate.ts` y formatea. Toda la
 * aritmética está en funciones puras con tests, y las cuatro definiciones del
 * plan —ocupación, clienta nueva, retención a 60 días, ingreso por hora de
 * silla— salen de `lib/metrics.ts` sin reimplementarse.
 *
 * ## Lo que este paquete NO pudo construir, y lo dice en pantalla
 *
 * - **Inasistencia por origen de reserva**: `ea_appointments` no tiene ninguna
 *   columna de origen. Verificado en la fuente de EA 1.6.0. El reporte entrega
 *   la mitad por franja y declara la otra.
 * - **Ocupación por estación** (cuál de los dos puestos): nada registra en qué
 *   estación se atendió una cita. Lo que sí se puede medir —y es lo que la
 *   pregunta "¿abro otro puesto?" necesita— es la ocupación agregada de las
 *   horas de puesto, y es lo que se muestra.
 */

export const metadata: Metadata = {
  title: "Reportes · Panel",
  robots: { index: false, follow: false },
};

/** El panel siempre quiere el estado de ahora; un reporte cacheado miente. */
export const dynamic = "force-dynamic";

/** `admin` en la base es "recepción" en la navegación. Igual que en Agenda. */
function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

export default async function ReportesPage({
  searchParams,
}: {
  // En Next 16 los parámetros de la petición son asíncronos.
  searchParams: Promise<{
    cadencia?: string;
    ancla?: string;
    desde?: string;
    hasta?: string;
  }>;
}) {
  let role: UserRole;

  try {
    // La compuerta de verdad. `nav.ts` esconde el destino de quien no es dueña,
    // pero esconder un enlace es cortesía: quien escriba la URL a mano tiene
    // que rebotar acá.
    ({ role } = await requireCapability("reportes:ver"));
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
    return (
      <AppShell role="staff" title="Reportes">
        <EmptyState
          icon="candado"
          title="Reportes es de la dueña"
          body="Tu rol no incluye los reportes del estudio. Tu liquidación y tu ticket promedio están en Comisiones."
        />
      </AppShell>
    );
  }

  const params = await searchParams;
  const now = new Date();
  const period = resolvePeriod(params, instantToEaDate(now));

  const data = await loadReports(period, now);

  const dbDown = data.problems.some((problem) => problem.source === "db");
  const eaDown = data.problems.some((problem) => problem.source === "ea");

  const shell = (children: React.ReactNode) => (
    <AppShell
      role={navRole(role)}
      title="Reportes"
      readOnly={
        eaDown
          ? { reason: "Easy!Appointments no respondió: faltan nombres, duraciones y estados." }
          : undefined
      }
    >
      <PeriodFilter period={period} />
      {children}
    </AppShell>
  );

  if (dbDown) {
    // Sin `gbs_admin` no queda reporte en pie, y nueve tarjetas en cero serían
    // peor que una pantalla honesta: un cero se lee como un dato.
    return shell(
      <EmptyState
        icon="alerta"
        title="No se pudo leer la base del panel"
        body="Toda la plata del estudio vive en gbs_admin y ahora mismo no responde, así que ningún reporte se puede calcular. Diagnóstico dice desde cuándo."
        action={
          <a className="ui-btn ui-btn--primary ui-btn--sm" href="/admin/diagnostico">
            Abrir Diagnóstico
          </a>
        }
      />
    );
  }

  return shell(
    <div className={styles.grid}>
      {period.cadence === "dia" ? <DailyReports data={data} /> : null}
      {period.cadence === "quincena" ? <FortnightReports data={data} /> : null}
      {period.cadence === "mes" ? <MonthlyReports data={data} /> : null}
    </div>,
  );
}

