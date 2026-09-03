/**
 * Los nueve reportes, ya armados. Server Components de presentación.
 *
 * Viven aparte de `page.tsx` por dos razones, y las dos importan:
 *
 * 1. **`page.tsx` se queda con lo que solo se puede hacer una vez**: la
 *    compuerta del DAL, el periodo, la carga de datos y el shell. Lo que
 *    dibuja cada reporte no tiene por qué compartir archivo con eso.
 * 2. **La vista previa los reusa tal cual.** La Definition of Done de este
 *    paquete pide revisar la pantalla en navegador a 390 / 768 / 1440, y eso
 *    necesita datos. Si la vista previa copiara el JSX se desactualizaría a la
 *    primera corrección, y estaríamos revisando una pantalla que no es la que
 *    se despliega.
 *
 * Ningún cálculo vive acá: se llama a `aggregate.ts` y se formatea. Y ninguna
 * métrica se recalcula — las cuatro definiciones del plan salen de
 * `lib/metrics.ts`.
 */

import { mapEaStatus } from "@/components/calendar";
import { EmptyState, formatCOP, formatDuration } from "@/components/ui";
import { stationHourOccupancy } from "@/lib/metrics";
import {
  bookedVsPerformed,
  chairHourReport,
  customersReport,
  dailyClose,
  dailySeries,
  extrasReport,
  noShowReport,
  PAYMENT_LABEL,
  settlement,
  toVisits,
  varianceReport,
  VARIANCE_LABEL,
} from "./aggregate";
import {
  axisTicks,
  BarRows,
  ChartFrame,
  Heatmap,
  StackBar,
  StatTile,
  TileRow,
  type BarDatum,
  type HeatCell,
} from "./Charts";
import styles from "./charts.module.css";
import { DataView } from "./DataView";
import { loadReports } from "./data";
import { occupancyByProvider, slotLabel, SLOTS, type SlotId } from "./occupancy";
import { SERIES, statusColor } from "./palette";
import { deltaAgainst, formatRate, NOT_MEASURABLE } from "./scale";

export type Data = Awaited<ReturnType<typeof loadReports>>;

const dash = "—";

/**
 * `$ 120.000`, o una raya cuando no hay dato.
 *
 * **Nunca `$ 0` por un `null`.** Una cuenta sin cerrar no cobró cero: no
 * cobró. Es la misma distinción que hacen `computeOccupancy()` y
 * `retentionRate()` al devolver `null`, y perderla acá la perdería en pantalla,
 * que es donde importa.
 */
function money(value: number | null | undefined): string {
  return value === null || value === undefined ? dash : formatCOP(value);
}

// ── Cadencia diaria ─────────────────────────────────────────────────────────

export function DailyReports({ data }: { data: Data }) {
  const close = dailyClose(data.finance, data.appointments, data.providers);
  const previous = dailyClose(data.previousFinance, [], data.providers);

  return (
    <ChartFrame
      title="Cierre del día"
      decision="¿Cuadra la caja? ¿Puedo cerrar? — el reparto por método tiene que coincidir con lo que hay en el cajón y en la cuenta."
      legend={close.byMethod.map((row, index) => ({
        label: row.label,
        color: SERIES[index] ?? SERIES[0],
      }))}
      note={
        close.blockers.length === 0
          ? undefined
          : {
              text: (
                <>
                  <strong>El día no se puede cerrar todavía:</strong>{" "}
                  {close.blockers.join(" · ")}.
                </>
              ),
            }
      }
      table={
        <DataView
          caption="Ingreso y propinas por técnica"
          columns={[
            { header: "Técnica", cell: (row) => row.name },
            { header: "Cuentas", numeric: true, cell: (row) => row.count },
            { header: "Ingreso", numeric: true, cell: (row) => money(row.revenue) },
            { header: "Propinas", numeric: true, cell: (row) => money(row.tips) },
          ]}
          rowKey={(row) => String(row.eaProviderId ?? "sin")}
          rows={close.byProvider}
        />
      }
    >
      <TileRow>
        <StatTile
          delta={deltaAgainst(close.revenue, previous.revenue)}
          deltaNote="vs. el día anterior"
          label="Ingreso del día"
          value={money(close.revenue)}
        />
        <StatTile
          label="Propinas"
          value={money(close.tips)}
          deltaNote="No entran al ingreso ni a la base de comisión"
        />
        <StatTile
          label="Cuentas cerradas"
          value={`${close.closedCount}`}
          deltaNote={
            close.pendingCount === 0
              ? "Ninguna pendiente"
              : `${close.pendingCount} pendiente${close.pendingCount === 1 ? "" : "s"}`
          }
        />
      </TileRow>

      <StackBar
        data={close.byMethod.map((row) => ({
          id: row.method,
          label: PAYMENT_LABEL[row.method],
          value: row.amount,
          display: money(row.amount),
        }))}
      />
    </ChartFrame>
  );
}

// ── Cadencia quincenal ──────────────────────────────────────────────────────

export function FortnightReports({ data }: { data: Data }) {
  const liquidacion = settlement(data.commissionEntries, data.providers);
  const variacion = varianceReport(data.finance, data.providers);

  const liquidacionAxis = axisTicks(
    Math.max(0, ...liquidacion.rows.map((row) => row.commission)),
    (value) => formatCOP(value),
  );

  const bars: BarDatum[] = liquidacion.rows.map((row) => ({
    id: String(row.eaProviderId),
    name: row.name,
    value: row.commission,
    display: money(row.commission),
    meta: `base ${money(row.base)}`,
  }));

  // Matriz técnica × motivo. El mapa de calor es la forma que resuelve el tope
  // de cuatro slots categóricos: cinco motivos no caben en la paleta sin
  // inventar tonos, y como magnitud no necesitan ninguno.
  const cells: HeatCell[][] = variacion.providers.map((provider) =>
    variacion.reasons.map((reason): HeatCell => {
      const cell = variacion.cells.find(
        (entry) =>
          entry.eaProviderId === provider.eaProviderId && entry.reason === reason.reason,
      );
      return cell === undefined
        ? { value: null, display: dash }
        : { value: cell.amount, display: formatCOP(cell.amount) };
    }),
  );

  return (
    <>
      <ChartFrame
        title="Liquidación de la quincena"
        decision="Cuánto se le paga a cada una. La cifra es la que congeló el motor de comisiones al liquidar; acá no se recalcula nada."
        note={
          liquidacion.rows.length === 0
            ? {
                tone: "info",
                text: (
                  <>
                    Todavía no hay renglones de comisión en este periodo. La liquidación se
                    calcula en <strong>Comisiones</strong>; este reporte solo la lee.
                  </>
                ),
              }
            : liquidacion.unmatched > 0
              ? {
                  text: (
                    <>
                      <strong>
                        {liquidacion.unmatched} renglón
                        {liquidacion.unmatched === 1 ? "" : "es"} sin regla aplicable
                      </strong>{" "}
                      — es cero <em>marcado</em>, no comisión cero: hay una regla por
                      configurar.
                    </>
                  ),
                }
              : undefined
        }
        table={
          <DataView
            caption="Base, comisión y estado de pago por técnica"
            columns={[
              { header: "Técnica", cell: (row) => row.name },
              { header: "Renglones", numeric: true, cell: (row) => row.entries },
              { header: "Base", numeric: true, cell: (row) => money(row.base) },
              { header: "Comisión", numeric: true, cell: (row) => money(row.commission) },
              { header: "Pagado", numeric: true, cell: (row) => money(row.paid) },
              { header: "Pendiente", numeric: true, cell: (row) => money(row.pending) },
              { header: "Sin regla", numeric: true, cell: (row) => row.unmatched },
            ]}
            rowKey={(row) => String(row.eaProviderId)}
            rows={liquidacion.rows}
          />
        }
      >
        <TileRow>
          <StatTile label="Base del periodo" value={money(liquidacion.totalBase)} />
          <StatTile label="Comisión total" value={money(liquidacion.totalCommission)} />
        </TileRow>
        {bars.length > 0 ? <BarRows axis={liquidacionAxis} data={bars} /> : null}
      </ChartFrame>

      <ChartFrame
        title="Variación de precio, por técnica y motivo"
        decision="Dónde se escapa la plata. Variación es lo cobrado por debajo del precio de lista, venga por descuento, por un total escrito a mano o por un renglón que resta."
        note={
          variacion.withoutReason > 0
            ? {
                text: (
                  <>
                    <strong>
                      {variacion.withoutReason} cuenta
                      {variacion.withoutReason === 1 ? "" : "s"} con variación y sin motivo
                    </strong>{" "}
                    — el panel no deja cerrar una así, así que se escribió por fuera.
                  </>
                ),
              }
            : undefined
        }
        table={
          <DataView
            caption="Variación por técnica"
            columns={[
              { header: "Técnica", cell: (row) => row.name },
              { header: "Variación", numeric: true, cell: (row) => money(row.amount) },
            ]}
            rowKey={(row) => String(row.eaProviderId ?? "sin")}
            rows={variacion.providers}
          />
        }
      >
        <TileRow>
          <StatTile label="Variación del periodo" value={money(variacion.total)} />
          <StatTile
            label="Peor caso de una cuenta"
            value={money(variacion.worst)}
            deltaNote="La mayor rebaja de un solo servicio"
          />
        </TileRow>

        {variacion.providers.length === 0 ? (
          <EmptyState
            icon="check"
            title="Sin variaciones en la quincena"
            body="Todas las cuentas cerradas cobraron el precio de lista. Cuando aparezca una rebaja, acá se ve de quién y por qué."
          />
        ) : (
          <Heatmap
            cells={cells}
            columns={variacion.reasons.map((reason) => ({
              id: reason.reason,
              label: reason.reason === "sin-motivo" ? "Sin motivo" : VARIANCE_LABEL[reason.reason],
            }))}
            rowHeader="Técnica"
            rows={variacion.providers.map((provider) => ({
              id: String(provider.eaProviderId ?? "sin"),
              label: provider.name,
            }))}
            scaleLabel={{ min: "menos", max: "más plata" }}
          />
        )}
      </ChartFrame>
    </>
  );
}

// ── Cadencia mensual ────────────────────────────────────────────────────────

export function MonthlyReports({ data }: { data: Data }) {
  const chair = chairHourReport(data.finance, data.services);
  const swaps = bookedVsPerformed(data.finance, data.services);
  const extras = extrasReport(data.finance, data.providers);
  const noShows = noShowReport(data.appointments);

  const visits = toVisits(data.visitHistory, data.legacyVisits);
  const clientas = customersReport(
    visits.visits,
    visits.withoutKey,
    { from: data.period.from, to: data.period.to },
    data.now,
  );

  // Ocupación: `computeOccupancy()` de B1 por técnica y
  // `stationHourOccupancy()` por hora de puesto, las dos de `lib/metrics.ts`.
  // Acá no se define nada; `occupancy.ts` solo traduce el plan de trabajo de EA
  // a intervalos.
  const perProvider = occupancyByProvider(
    data.providers.map((provider) => ({
      eaProviderId: provider.id,
      name: provider.name,
      window: data.providerWindows.get(provider.id) ?? { open: [], breaks: [] },
      blocked: [
        ...(data.blocks.byProvider.get(provider.id) ?? []),
        ...data.blocks.studio,
      ],
      appointments: data.appointments
        .filter((appointment) => appointment.eaProviderId === provider.id)
        .map((appointment) => ({
          start: appointment.start,
          end: appointment.end,
          // Una inasistencia **no** cuenta como ocupada: la silla estuvo vacía,
          // y eso es exactamente lo que el reporte tiene que mostrar.
          //
          // Se pregunta por `mapEaStatus`, la tabla de C1, y no por una
          // expresión regular sobre el texto crudo de EA. Una segunda forma de
          // traducir el estado es una segunda definición de "atendida", y la
          // que se separe en silencio va a ser la que decide una ocupación.
          attended: mapEaStatus(appointment.status) === "completada",
        })),
    })),
  );

  const stations = stationHourOccupancy({
    stations: data.stations,
    studioWindow: data.studioWindow,
    studioBlocked: data.blocks.studio,
    perProvider,
  });

  const revenue = data.finance
    .filter((row) => row.closed && row.amountCharged !== null)
    .reduce((total, row) => total + (row.amountCharged ?? 0), 0);
  const previousRevenue = data.previousFinance
    .filter((row) => row.closed && row.amountCharged !== null)
    .reduce((total, row) => total + (row.amountCharged ?? 0), 0);

  const chairAxis = axisTicks(
    Math.max(0, ...chair.rows.map((row) => row.perHour ?? 0)),
    (value) => formatCOP(value),
  );

  const extrasAxis = axisTicks(1, (value) => formatRate(value), 4);

  const slotIds: SlotId[] = noShows.slots.map((slot) => slot.slot);

  return (
    <>
      {/* --- Rentabilidad por hora de silla ------------------------------- */}
      <ChartFrame
        title="Rentabilidad por hora de silla"
        decision="Qué empujar y qué re-tarifar. Es el que Agenda Pro no daba: un combo de $95.000 en 120 min rinde más por minuto que un montaje de $115.000 en 150."
        note={
          chair.withoutDuration > 0
            ? {
                text: (
                  <>
                    <strong>
                      {chair.withoutDuration} servicio
                      {chair.withoutDuration === 1 ? "" : "s"} sin duración en el catálogo
                    </strong>{" "}
                    — sin minutos no hay rendimiento que calcular. Van al final de la lista.
                  </>
                ),
              }
            : undefined
        }
        table={
          <DataView
            caption="Ingreso por hora de silla, por servicio realizado"
            columns={[
              { header: "Servicio", cell: (row) => row.name },
              { header: "Cuentas", numeric: true, cell: (row) => row.tickets },
              { header: "Ingreso", numeric: true, cell: (row) => money(row.revenue) },
              {
                header: "Minutos",
                numeric: true,
                cell: (row) => (row.minutes === 0 ? dash : formatDuration(row.minutes)),
              },
              {
                header: "$ / hora",
                numeric: true,
                cell: (row) => (row.perHour === null ? dash : formatCOP(Math.round(row.perHour))),
              },
            ]}
            rowKey={(row) => String(row.key ?? "sin")}
            rows={chair.rows}
          />
        }
      >
        <TileRow>
          <StatTile
            delta={deltaAgainst(revenue, previousRevenue)}
            deltaNote="vs. el periodo anterior"
            label="Ingreso del periodo"
            spark={dailySeries(data.finance, data.days)}
            value={money(revenue)}
          />
          <StatTile
            label="El servicio que más rinde"
            soft
            value={chair.rows[0]?.name ?? dash}
            deltaNote={
              chair.rows[0]?.perHour === null || chair.rows[0] === undefined
                ? undefined
                : `${formatCOP(Math.round(chair.rows[0].perHour ?? 0))} por hora de silla`
            }
          />
        </TileRow>

        {chair.rows.length === 0 ? (
          <EmptyState
            icon="reportes"
            title="Todavía no hay cuentas cerradas en el periodo"
            body="El rendimiento por hora de silla se calcula sobre lo que se cobró, así que aparece cuando la primera cuenta del periodo se cierre."
          />
        ) : (
          <BarRows
            axis={chairAxis}
            data={chair.rows.map((row, index) => ({
              // El color sigue al servicio, no a su puesto en el ranking: el
              // primero se resalta y el resto va en gris, que es la forma
              // "emphasis" — la historia de este reporte es una sola fila.
              id: String(row.key ?? "sin"),
              name: row.name,
              value: row.perHour ?? 0,
              display: row.perHour === null ? dash : `${formatCOP(Math.round(row.perHour))}/h`,
              meta: row.minutes === 0 ? "sin duración" : formatDuration(row.minutes),
              emphasis: index === 0,
            }))}
          />
        )}
      </ChartFrame>

      {/* --- Ocupación ---------------------------------------------------- */}
      <ChartFrame
        title="Ocupación por hora de puesto y por técnica"
        decision="¿Contrato a alguien? ¿Abro otro puesto? Con dos estaciones la capacidad del negocio son horas de puesto, no personas."
        note={{
          tone: "info",
          text: (
            <>
              <strong>No se puede decir cuál</strong> de los dos puestos se usó: ninguna
              tabla lo registra —EA no tiene el concepto de puesto y el panel no guarda la
              asignación—. Lo que se mide es el agregado, que es lo que la pregunta necesita.
              {stations.overCapacityMinutes > 0 ? (
                <>
                  {" "}
                  Y hubo <strong>{formatDuration(stations.overCapacityMinutes)}</strong> de
                  citas simultáneas por encima de los {stations.stations} puestos: eso es
                  físicamente imposible, hay que revisar los datos.
                </>
              ) : null}
            </>
          ),
        }}
        table={
          <DataView
            caption="Ocupación por técnica"
            columns={[
              { header: "Técnica", cell: (row) => row.name },
              {
                header: "Disponible",
                numeric: true,
                cell: (row) => formatDuration(row.occupancy.availableMinutes),
              },
              {
                header: "Atendido",
                numeric: true,
                cell: (row) => formatDuration(row.occupancy.busyMinutes),
              },
              {
                header: "Fuera de plan",
                numeric: true,
                cell: (row) =>
                  row.occupancy.overflowMinutes === 0
                    ? dash
                    : formatDuration(row.occupancy.overflowMinutes),
              },
              {
                header: "Ocupación",
                numeric: true,
                cell: (row) => formatRate(row.occupancy.rate),
              },
            ]}
            rowKey={(row) => String(row.eaProviderId)}
            rows={perProvider}
          />
        }
      >
        <TileRow>
          <StatTile
            label={`Horas de puesto usadas (${stations.stations || "sin"} puesto${stations.stations === 1 ? "" : "s"})`}
            soft={stations.rate === null}
            value={formatRate(stations.rate)}
            deltaNote={
              stations.capacityMinutes === 0
                ? "El estudio no abrió en el periodo"
                : `${formatDuration(stations.usedMinutes)} de ${formatDuration(stations.capacityMinutes)}`
            }
          />
        </TileRow>

        {perProvider.length === 0 ? (
          <EmptyState
            icon="equipo"
            title="No hay técnicas con plan de trabajo"
            body="La ocupación necesita el plan de trabajo que vive en Easy!Appointments. Equipo muestra cuál falta."
          />
        ) : (
          <BarRows
            axis={axisTicks(1, (value) => formatRate(value), 4)}
            data={perProvider.map((provider) => ({
              id: String(provider.eaProviderId),
              name: provider.name,
              value: provider.occupancy.rate ?? 0,
              display: formatRate(provider.occupancy.rate),
              meta: formatDuration(provider.occupancy.busyMinutes),
            }))}
          />
        )}
      </ChartFrame>

      {/* --- Agendado vs. realizado --------------------------------------- */}
      <ChartFrame
        title="Servicio agendado vs. realizado"
        decision="Arreglar el menú o el flujo de reserva, no a la técnica: la tasa de cambio es una señal de la vitrina, no un error de quien atendió."
        table={
          <DataView
            caption="Cambios de servicio más frecuentes"
            columns={[
              { header: "Se agendó", cell: (row) => row.from },
              { header: "Se hizo", cell: (row) => row.to },
              { header: "Veces", numeric: true, cell: (row) => row.count },
              {
                header: "Diferencia",
                numeric: true,
                cell: (row) => `${row.delta >= 0 ? "+" : "−"}${formatCOP(Math.abs(row.delta))}`,
              },
            ]}
            rowKey={(row) => `${row.fromId}-${row.toId}`}
            rows={swaps.flows}
          />
        }
      >
        <TileRow>
          <StatTile
            label="Tasa de cambio de servicio"
            soft={swaps.rate === null}
            value={formatRate(swaps.rate)}
            deltaNote={
              swaps.comparable === 0
                ? "Sin cuentas comparables en el periodo"
                : `${swaps.changed} de ${swaps.comparable} cuentas`
            }
          />
        </TileRow>

        {swaps.flows.length === 0 ? (
          <EmptyState
            icon="check"
            title="Se hizo lo que se agendó"
            body="Ninguna cuenta del periodo cambió de servicio. Cuando pase, acá aparece hacia qué y cuánta plata movió."
          />
        ) : (
          <BarRows
            axis={axisTicks(Math.max(...swaps.flows.map((flow) => flow.count)), (value) =>
              String(Math.round(value)),
            )}
            data={swaps.flows.map((flow) => ({
              id: `${flow.fromId}-${flow.toId}`,
              name: `${flow.from} → ${flow.to}`,
              value: flow.count,
              display: `${flow.count}`,
              meta: `${flow.delta >= 0 ? "+" : "−"}${formatCOP(Math.abs(flow.delta))}`,
            }))}
          />
        )}
      </ChartFrame>

      {/* --- Adicionales -------------------------------------------------- */}
      <ChartFrame
        title="Adicionales: enganche por técnica"
        decision="Dónde entrenar y qué ofrecer por defecto. El monto va en la tabla y no en el mismo gráfico: son dos medidas de escala distinta, y un doble eje inventaría una correlación."
        table={
          <DataView
            caption="Enganche y monto de adicionales por técnica"
            columns={[
              { header: "Técnica", cell: (row) => row.name },
              { header: "Cuentas", numeric: true, cell: (row) => row.tickets },
              { header: "Con adicional", numeric: true, cell: (row) => row.withExtras },
              { header: "Enganche", numeric: true, cell: (row) => formatRate(row.attachRate) },
              { header: "Monto", numeric: true, cell: (row) => money(row.amount) },
              {
                header: "Por cuenta",
                numeric: true,
                cell: (row) =>
                  row.perTicket === null ? dash : formatCOP(Math.round(row.perTicket)),
              },
            ]}
            rowKey={(row) => String(row.eaProviderId ?? "sin")}
            rows={extras.rows}
          />
        }
      >
        <TileRow>
          <StatTile
            label="Enganche del estudio"
            soft={extras.attachRate === null}
            value={formatRate(extras.attachRate)}
          />
          <StatTile label="Monto en adicionales" value={money(extras.total)} />
        </TileRow>

        {extras.rows.length === 0 ? (
          <EmptyState
            icon="reportes"
            title="Todavía no hay cuentas cerradas"
            body="El enganche de adicionales se mide sobre cuentas cerradas. Aparece con la primera del periodo."
          />
        ) : (
          <BarRows
            axis={extrasAxis}
            data={extras.rows.map((row) => ({
              id: String(row.eaProviderId ?? "sin"),
              name: row.name,
              value: row.attachRate ?? 0,
              display: formatRate(row.attachRate),
              meta: money(row.amount),
            }))}
          />
        )}
      </ChartFrame>

      {/* --- Clientas ----------------------------------------------------- */}
      <ChartFrame
        title="Clientas nuevas vs. que vuelven"
        decision="Cuánto invertir en captación vs. en volver a traer."
        legend={[
          { label: "Nuevas", color: SERIES[0] },
          { label: "Que vuelven", color: SERIES[1] },
        ]}
        note={
          clientas.withoutKey > 0
            ? {
                tone: "info",
                text: (
                  <>
                    {clientas.withoutKey} visita
                    {clientas.withoutKey === 1 ? "" : "s"} sin teléfono quedaron fuera de la
                    cuenta: la identidad de la clienta es el teléfono, y sin él no hay forma
                    de saber si volvió.
                  </>
                ),
              }
            : undefined
        }
        table={
          <DataView
            caption="Composición de la clientela del periodo"
            columns={[
              { header: "Grupo", cell: (row) => row.label },
              { header: "Clientas", numeric: true, cell: (row) => row.value },
            ]}
            rowKey={(row) => row.label}
            rows={[
              { label: "Nuevas", value: clientas.newCustomers },
              { label: "Que vuelven", value: clientas.returningCustomers },
            ]}
          />
        }
      >
        <TileRow>
          <StatTile
            label="Nuevas en el periodo"
            value={`${clientas.newCustomers}`}
            deltaNote={
              clientas.newShare === null
                ? "Sin clientas atendidas"
                : `${formatRate(clientas.newShare)} de las atendidas`
            }
          />
          <StatTile
            label="Retención a 60 días"
            soft={clientas.retention.rate === null}
            value={formatRate(clientas.retention.rate)}
            deltaNote={
              clientas.retention.rate === null
                ? `${clientas.retention.pending} cohorte${clientas.retention.pending === 1 ? "" : "s"} con la ventana abierta`
                : `${clientas.retention.returned} de ${clientas.retention.cohort - clientas.retention.pending} volvieron`
            }
          />
        </TileRow>

        <StackBar
          data={[
            {
              id: "nuevas",
              label: "Nuevas",
              value: clientas.newCustomers,
              display: `${clientas.newCustomers}`,
            },
            {
              id: "vuelven",
              label: "Que vuelven",
              value: clientas.returningCustomers,
              display: `${clientas.returningCustomers}`,
            },
          ]}
        />

        {clientas.retention.rate === null && clientas.retention.cohort > 0 ? (
          <p className={styles.decision}>
            La retención dice <strong>{NOT_MEASURABLE}</strong> porque{" "}
            {clientas.retention.pending} de las {clientas.retention.cohort} clientas del
            periodo todavía están dentro de sus 60 días. Contarlas como &laquo;no
            volvió&raquo; haría que este número se viera catastrófico hoy y mejorara solo en
            dos meses, sin que cambiara un solo dato.
          </p>
        ) : null}
      </ChartFrame>

      {/* --- Inasistencia ------------------------------------------------- */}
      <ChartFrame
        title="Inasistencia por franja"
        decision="Si el recordatorio funciona, y si algún horario no vale la pena abrir."
        legend={[
          { label: "No asistió", color: statusColor("no-asistio") },
          { label: "Cancelada", color: statusColor("cancelada") },
        ]}
        note={{
          text: (
            <>
              <strong>El origen de la reserva no se puede reportar.</strong>{" "}
              <code>ea_appointments</code> no tiene ninguna columna de origen —ni{" "}
              <code>booking_source</code>, ni <code>source</code>, ni <code>channel</code>—;
              verificado en la fuente de EA 1.6.0. <code>id_google_calendar</code> no sirve
              de proxy: dice si la cita se espejó en Google, no de dónde vino. Fingir un
              origen sería peor que no mostrarlo, porque la decisión que habilita es apagar
              un canal de reserva.
              {noShows.unmapped.length > 0 ? (
                <>
                  {" "}
                  Además, {noShows.unmapped.length} estado
                  {noShows.unmapped.length === 1 ? "" : "s"} de EA sin traducción quedaron
                  fuera del denominador: alguien editó la lista de estados.
                </>
              ) : null}
            </>
          ),
        }}
        table={
          <DataView
            caption="Inasistencia y cancelación por franja horaria"
            columns={[
              { header: "Franja", cell: (row) => row.label },
              { header: "Citas", numeric: true, cell: (row) => row.scheduled },
              { header: "No asistió", numeric: true, cell: (row) => row.noShows },
              { header: "Canceladas", numeric: true, cell: (row) => row.cancelled },
              { header: "Tasa", numeric: true, cell: (row) => formatRate(row.rate) },
            ]}
            rowKey={(row) => row.slot}
            rows={noShows.slots}
          />
        }
      >
        <TileRow>
          <StatTile
            label="Inasistencia del periodo"
            soft={noShows.rate === null}
            value={formatRate(noShows.rate)}
            deltaNote={`${noShows.noShows} de ${noShows.scheduled} citas`}
          />
          <StatTile
            label="Canceladas"
            value={`${noShows.cancelled}`}
            deltaNote="Con aviso: la silla quedó libre a tiempo"
          />
        </TileRow>

        {noShows.scheduled === 0 ? (
          <EmptyState
            icon="agenda"
            title="Sin citas en el periodo"
            body="La inasistencia se mide sobre las citas que llegaron a su fecha. Aparece cuando el periodo tenga agenda."
          />
        ) : (
          <Heatmap
            cells={slotIds.map((slot) => {
              const row = noShows.slots.find((entry) => entry.slot === slot);
              const empty: HeatCell = { value: null, display: dash };
              if (row === undefined || row.scheduled === 0) return [empty, empty, empty];
              return [
                { value: row.noShows, display: `${row.noShows}` },
                { value: row.cancelled, display: `${row.cancelled}` },
                { value: row.scheduled, display: `${row.scheduled}` },
              ];
            })}
            columns={[
              { id: "no-asistio", label: "No asistió" },
              { id: "cancelada", label: "Cancelada" },
              { id: "citas", label: "Citas" },
            ]}
            rowHeader="Franja"
            rows={slotIds.map((slot) => ({
              id: slot,
              label: SLOTS.find((entry) => entry.id === slot)?.label ?? slotLabel(slot),
            }))}
            scaleLabel={{ min: "menos", max: "más" }}
          />
        )}
      </ChartFrame>
    </>
  );
}
