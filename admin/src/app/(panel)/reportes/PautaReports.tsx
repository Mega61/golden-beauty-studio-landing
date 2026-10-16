/**
 * Los dos reportes de pauta: **demanda por día y hora** y **costo por clienta
 * nueva**. Server Components de presentación, como `Reports.tsx`, que los
 * dibuja dentro de la cadencia mensual.
 *
 * Existen por la metodología de anuncios con la que trabaja la dueña, que hace
 * tres preguntas que el set original no respondía: cuándo pasa la demanda
 * (para programar anuncios y promos), cuánto cuesta traer a una clienta nueva,
 * y a quién excluir de la captación (eso último es la exportación para Meta de
 * `/clientes/exportar-meta`, no un reporte).
 *
 * Ningún cálculo vive acá: `demand.ts` y `acquisition.ts` son puros y tienen
 * tests; "clienta nueva" sale de `splitCustomers()` de `lib/metrics.ts`.
 */

import { Fragment } from "react";

import { formatCOP } from "@/components/ui";
import type { VisitRecord } from "@/lib/metrics";

import { acquisitionReport, AD_CHANNEL_LABEL } from "./acquisition";
import { AdSpendForm } from "./AdSpendForm";
import { BarRows, ChartFrame, Heatmap, StatTile, TileRow, type HeatCell } from "./Charts";
import styles from "./charts.module.css";
import { DataView } from "./DataView";
import type { ReportData } from "./data";
import { demandReport, hourLabel, WEEK_ORDER, WEEKDAY_SHORT } from "./demand";
import { monthName } from "./period";
import { axisTicks, formatRate } from "./scale";

const dash = "—";

function money(value: number | null | undefined): string {
  return value === null || value === undefined ? dash : formatCOP(value);
}

/** `"2026-08"` → `"agosto de 2026"`. */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${monthName(m)} de ${y}`;
}

function listMonths(months: readonly string[]): string {
  const labels = months.map(monthLabel);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}`;
}

/** `1.5` → `"1,5"`. Una cifra de citas por día no es plata ni porcentaje. */
function perDay(value: number | null): string {
  if (value === null) return dash;
  return value.toLocaleString("es-CO", { maximumFractionDigits: 1 });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Demanda por día y hora ──────────────────────────────────────────────────

export function DemandFrame({ data }: { data: ReportData }) {
  const demand = demandReport({
    period: { from: data.period.from, to: data.period.to },
    appointments: data.appointments,
    legacy: data.legacyVisits,
    finance: data.finance,
    open: data.studioWindow.open,
  });

  // La matriz se dibuja con las **horas en filas** y los siete días en
  // columnas: siete columnas angostas caben a 390 px, y doce o trece horas en
  // columnas obligaban a scrollear de lado el mapa que hay que leer de un
  // vistazo.
  const cells: HeatCell[][] = demand.hours.map((_, hourIndex) =>
    WEEK_ORDER.map((_, dayIndex): HeatCell => {
      const cell = demand.cells[dayIndex]?.[hourIndex];
      if (cell === undefined || !cell.open) return { value: null, display: "" };
      return { value: cell.count, display: String(cell.count) };
    }),
  );

  const openDays = demand.days.filter((day) => day.openDays > 0 || day.revenue > 0);
  const revenueAxis = axisTicks(
    Math.max(0, ...openDays.map((day) => day.revenue)),
    (value) => formatCOP(value),
  );

  const noteParts: React.ReactNode[] = [];
  noteParts.push(
    <Fragment key="n1">
      Cuenta citas atendidas y agendadas por su hora de inicio.{" "}
      <strong>Las inasistencias sí cuentan</strong> ({demand.noShows}): alguien pidió esa hora,
      y que no llegara es tema del recordatorio. Las canceladas ({demand.cancelled}) no.
    </Fragment>,
  );
  if (demand.fromLegacy > 0) {
    noteParts.push(
      <Fragment key="n2">
        {" "}
        {plural(demand.fromLegacy, "cita sale", "citas salen")} del histórico de Agenda Pro: entran
        al mapa, pero no al ingreso, que se lee solo de las cuentas cerradas en el panel.
      </Fragment>,
    );
  }
  if (demand.unmapped > 0) {
    noteParts.push(
      <Fragment key="n3">
        {" "}
        {plural(demand.unmapped, "cita con un estado", "citas con estados")} de EA sin traducción
        quedaron fuera.
      </Fragment>,
    );
  }
  if (!demand.hasOpenInfo) {
    noteParts.push(
      <Fragment key="n4">
        {" "}
        <strong>Sin plan de trabajo que leer:</strong> &laquo;día abierto&raquo; se aproxima con
        &laquo;tuvo citas&raquo;, así que el día más flojo puede no aparecer.
      </Fragment>,
    );
  }

  return (
    <ChartFrame
      title="Demanda por día y hora"
      decision="Cuándo pautar y qué día empujar con una promo. El anuncio va antes de la hora que se llena; la promo, al día que no."
      note={{ tone: "info", text: <>{noteParts}</> }}
      table={
        <DataView
          caption="Demanda e ingreso por día de la semana"
          columns={[
            { header: "Día", cell: (row) => row.label },
            { header: "Citas", numeric: true, cell: (row) => row.count },
            { header: "Días abiertos", numeric: true, cell: (row) => row.openDays },
            { header: "Citas por día", numeric: true, cell: (row) => perDay(row.perOpenDay) },
            { header: "Cuentas", numeric: true, cell: (row) => row.tickets },
            { header: "Ingreso", numeric: true, cell: (row) => money(row.revenue) },
          ]}
          rowKey={(row) => row.weekday}
          rows={demand.days}
        />
      }
    >
      <TileRow>
        <StatTile
          label="El día más lleno"
          soft={demand.busiest === null}
          value={demand.busiest?.label ?? "Sin citas"}
          deltaNote={
            demand.busiest === null
              ? undefined
              : `${perDay(demand.busiest.perOpenDay)} citas por ${demand.busiest.label.toLowerCase()} abierto`
          }
        />
        <StatTile
          label="El día abierto más flojo"
          soft={demand.slowest === null}
          value={demand.slowest?.label ?? dash}
          deltaNote={
            demand.slowest === null
              ? "Hace falta más de un día abierto para comparar"
              : `${perDay(demand.slowest.perOpenDay)} citas por ${demand.slowest.label.toLowerCase()} abierto: el día para la promo`
          }
        />
        <StatTile
          label="Hora pico"
          soft={demand.peakHour === null}
          value={demand.peakHour === null ? dash : hourLabel(demand.peakHour)}
          deltaNote={`${plural(demand.total, "cita", "citas")} en el periodo`}
        />
      </TileRow>

      {demand.total === 0 ? (
        <p className={styles.decision}>Sin citas en el periodo: no hay demanda que dibujar todavía.</p>
      ) : (
        <Heatmap
          cells={cells}
          columns={WEEK_ORDER.map((weekday) => ({ id: weekday, label: WEEKDAY_SHORT[weekday] }))}
          dense
          rowHeader="Hora"
          rows={demand.hours.map((hour) => ({ id: String(hour), label: hourLabel(hour) }))}
          scaleLabel={{ min: "pocas citas", max: "muchas" }}
        />
      )}

      {openDays.some((day) => day.revenue > 0) ? (
        <>
          <p className={styles.decision}>
            <strong>Ingreso por día de la semana</strong> — cuentas cerradas, al precio que se cobró.
          </p>
          <BarRows
            axis={revenueAxis}
            data={openDays.map((day) => ({
              id: day.weekday,
              name: day.label,
              value: day.revenue,
              display: money(day.revenue),
              meta: plural(day.tickets, "cuenta", "cuentas"),
            }))}
          />
        </>
      ) : null}
    </ChartFrame>
  );
}

// ── Costo por clienta nueva ─────────────────────────────────────────────────

export function AcquisitionFrame({
  data,
  visits,
  canEdit,
}: {
  data: ReportData;
  /** La unión EA + legacy que ya armó `MonthlyReports` para el reporte de clientas. */
  visits: readonly VisitRecord[];
  canEdit: boolean;
}) {
  const customerOf = new Map(
    data.appointments.map((appointment) => [appointment.id, appointment.customerKey] as const),
  );

  const report = acquisitionReport({
    period: { from: data.period.from, to: data.period.to },
    visits,
    finance: data.finance,
    customerOf,
    adSpend: data.adSpend,
  });

  const costValue = (() => {
    switch (report.state) {
      case "ok":
        return money(report.costPerNew);
      case "sin-inversion":
        return "sin inversión registrada";
      case "sin-pauta":
        return "no se pautó";
      case "sin-clientas":
        return "sin clientas nuevas";
      case "sin-lectura":
        return "no se pudo leer";
    }
  })();

  const notes: React.ReactNode[] = [];
  if (report.state === "sin-lectura") {
    notes.push(
      <Fragment key="n5">
        <strong>No se pudo leer la inversión en anuncios.</strong> Falta aplicar la migración 023
        (<code>ad_spend</code>) o la base no respondió. Las clientas nuevas y lo que pagaron sí
        salen.
      </Fragment>,
    );
  }
  if (report.partialMonths.length > 0) {
    notes.push(
      <Fragment key="n6">
        {" "}
        El periodo no cubre {report.partialMonths.length === 1 ? "el mes" : "los meses"} de{" "}
        {listMonths(report.partialMonths)} completo
        {report.partialMonths.length === 1 ? "" : "s"}, y se sumó su inversión entera: la pauta se
        anota por mes y no se prorratea, porque no se gasta pareja.
      </Fragment>,
    );
  }
  if (report.state !== "sin-lectura" && report.missingMonths.length > 0 && report.spend !== null) {
    notes.push(
      <Fragment key="n7">
        {" "}
        Sin inversión anotada para {listMonths(report.missingMonths)}: el costo puede salir bajo.
      </Fragment>,
    );
  }

  const bars =
    report.spend !== null && report.spend > 0
      ? [
          {
            id: "inversion",
            name: "Inversión en anuncios",
            value: report.spend,
            display: money(report.spend),
            // La inversión es la vara contra la que se mide, no el dato: va en
            // el gris de de-énfasis y lo pagado en el tono de la serie.
            emphasis: false,
          },
          {
            id: "pagado",
            name: "Lo que pagaron las nuevas",
            value: report.revenueFromNew,
            display: money(report.revenueFromNew),
            meta: plural(report.newWithRevenue, "clienta", "clientas"),
          },
        ]
      : [];

  return (
    <ChartFrame
      title="Costo por clienta nueva"
      decision="Si la pauta se paga sola: cuánto costó traer a cada clienta nueva, y cuánto de eso ya volvió en lo que pagaron."
      note={notes.length > 0 ? { tone: "info", text: <>{notes}</> } : undefined}
      table={
        <DataView
          caption="Inversión en anuncios por canal en el periodo"
          columns={[
            { header: "Canal", cell: (row) => AD_CHANNEL_LABEL[row.channel] },
            { header: "Inversión", numeric: true, cell: (row) => money(row.amount) },
          ]}
          rowKey={(row) => row.channel}
          rows={report.byChannel}
        />
      }
    >
      <TileRow>
        <StatTile
          label="Clientas nuevas"
          value={String(report.newCustomers)}
          deltaNote="La misma cuenta de «Clientas nuevas vs. que vuelven»"
        />
        <StatTile
          label="Inversión en anuncios"
          soft={report.spend === null}
          value={report.spend === null ? "sin inversión registrada" : money(report.spend)}
          deltaNote={listMonths(report.months)}
        />
        <StatTile
          label="Costo por clienta nueva"
          soft={report.costPerNew === null}
          value={costValue}
          deltaNote={
            report.state === "ok"
              ? `${money(report.spend)} ÷ ${plural(report.newCustomers, "nueva", "nuevas")}`
              : undefined
          }
        />
        <StatTile
          label="Ya recuperado"
          soft={report.recovered === null}
          value={report.recovered === null ? dash : formatRate(report.recovered)}
          deltaNote={
            report.spend === null || report.spend === 0
              ? `${money(report.revenueFromNew)} pagado por las nuevas`
              : `${money(report.revenueFromNew)} de ${money(report.spend)}`
          }
        />
      </TileRow>

      {bars.length > 0 ? (
        <BarRows
          axis={axisTicks(Math.max(...bars.map((bar) => bar.value)), (value) => formatCOP(value))}
          data={bars}
        />
      ) : null}

      {canEdit ? <AdSpendForm defaultMonth={report.months[0] ?? ""} /> : null}
    </ChartFrame>
  );
}
