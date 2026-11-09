import Link from "next/link";

import {
  Card,
  CardHead,
  DataTable,
  DateStepper,
  EmptyState,
  Icon,
  StatusPill,
  formatCOP,
  formatDateLong,
  formatPesos,
  formatTime,
  type Column,
} from "@/components/ui";
import { mapEaStatus } from "@/components/calendar/status-map";
import type { DayAccount, DayIssue, DayTotals } from "@/jobs/day-close";

import { SincronizarAhora } from "./CajaAcciones";
import type { CajaView } from "./data";

/**
 * **Caja** — el día completo: lo que quedó sin cobrar, el cuadre del cajón y
 * qué ya llegó a Actual.
 *
 * ## No hay cierre del día
 *
 * Hasta 2026-11-09 esta pantalla tenía un botón "Cerrar el día" que era lo
 * único que mandaba la plata a Actual, y que no se podía apretar mientras
 * quedara una cita sin cuenta. Ya no: cobrar en Hoy es el único paso, y lo
 * cobrado sale solo cada noche (`jobs/nightly-sync.ts`). Esta pantalla quedó
 * para **mirar**: cuadrar el efectivo contra el cajón, ver qué falta cobrar y
 * saber qué ya está en Actual. "Sincronizar ahora" existe para no esperar a
 * la noche, no porque haga falta.
 *
 * ## El orden de la pantalla
 *
 * Lo pendiente va **arriba**: es lo único de la pantalla que pide hacer algo,
 * y se hace desde Hoy, no desde acá.
 *
 * ## Por qué no hay ningún gráfico
 *
 * Tres montos que se leen como cifras exactas —"¿cuánto hay en efectivo?"— son
 * una **fila de tiles**, no un gráfico de barras de tres barras (el heurístico
 * de forma de la skill `dataviz` lo dice explícitamente: "a handful of headline
 * numbers → KPI row, not a grouped bar chart"). Y como no hay series, no se
 * asigna ni un color categórico: el método de pago se distingue por su
 * etiqueta, en tinta de texto. El dorado del sistema es acción y foco, nunca un
 * dato (A3).
 *
 * La cifra grande usa `--text-xl` (24 px) y no los ≥48 px que sugiere la skill,
 * porque la escala tipográfica de este panel es cerrada y 48 px no existe en
 * ella; el sistema de diseño manda sobre el default de la skill.
 */
export function CajaVista({ view }: { view: CajaView }) {
  const { review, pendingPush, pushEnabled, date, today } = view;
  const pendientes = review.issues.filter((i) => i.blocks);
  const enCurso = review.issues.filter((i) => !i.blocks);

  // El único cruce entre `easyappointments` y `gbs_admin`: no hay JOIN posible
  // —se leen con usuarios de MySQL distintos— así que se hace en memoria por
  // `ea_appointment_id`, que es la llave que las dos fuentes comparten.
  const nombres = new Map(
    (review.appointments ?? []).map((a) => [a.eaAppointmentId, a.customerName]),
  );

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Fecha date={date} today={today} />

      <Pendientes
        date={date}
        pendientes={pendientes}
        enCurso={enCurso}
        sinAgenda={review.appointments === null}
      />

      <Totales totals={review.totals} />

      <Cerradas accounts={review.closed} nombres={nombres} />

      <Sincronizacion view={view} />

      {pendingPush.length === 0 ? null : (
        <SinEmpujar rows={pendingPush} pushEnabled={pushEnabled} />
      )}
    </div>
  );
}

// ── Fecha ───────────────────────────────────────────────────────────────────

/**
 * El día que se está mirando, y cómo moverse.
 *
 * Para mirar —y cuadrar— un día anterior. Son enlaces y no un control con estado — la pantalla es un Server Component y
 * navegar es lo que ya sabe hacer.
 */
function Fecha({ date, today }: { date: string; today: string }) {
  const anterior = shiftDate(date, -1);
  const siguiente = shiftDate(date, 1);
  const isToday = date === today;

  return (
    <DateStepper
      label={formatDateLong(`${date} 00:00:00`)}
      sub={isToday ? "Hoy" : siguiente === today ? "Ayer" : "Día anterior"}
      prevHref={`/caja?fecha=${anterior}`}
      nextHref={isToday ? null : siguiente === today ? "/caja" : `/caja?fecha=${siguiente}`}
      todayHref={isToday ? null : "/caja"}
    />
  );
}

/** Un día antes o después, en calendario. Sin husos: es una fecha, no un instante. */
function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// ── Pendientes ──────────────────────────────────────────────────────────────

const ISSUE_COLUMNS: ReadonlyArray<Column<DayIssue>> = [
  {
    key: "clienta",
    header: "Cliente",
    from: "siempre",
    listSlot: "primary",
    render: (row) => row.customerName,
    text: (row) => row.customerName,
  },
  {
    key: "hora",
    header: "Hora",
    from: "siempre",
    listSlot: "secondary",
    width: "7rem",
    render: (row) => (row.start === null ? "—" : formatTime(row.start)),
    text: (row) => (row.start === null ? "—" : formatTime(row.start)),
  },
  // `oculto` y no `secondary`: la segunda línea de la lista es **una sola línea
  // con elipsis** (así la diseñó A3), y con hora + profesional + motivo adentro
  // lo que se recorta es justo el motivo, que es para lo que la lista existe.
  // La profesional se conserva en la tabla, de 768 px para arriba.
  {
    key: "profesional",
    header: "Profesional",
    from: "md",
    listSlot: "oculto",
    render: (row) => row.providerName,
    text: (row) => row.providerName,
  },
  {
    key: "falta",
    header: "Qué falta",
    from: "siempre",
    listSlot: "secondary",
    render: (row) => row.message,
    text: (row) => row.message,
  },
  {
    key: "estado",
    header: "Estado",
    from: "md",
    listSlot: "trailing",
    render: (row) =>
      row.status === "" ? <span aria-hidden>—</span> : <StatusPill status={mapEaStatus(row.status)} size="sm" />,
    text: (row) => row.status,
  },
];

function Pendientes({
  date,
  pendientes,
  enCurso,
  sinAgenda,
}: {
  date: string;
  pendientes: readonly DayIssue[];
  enCurso: readonly DayIssue[];
  /** EA no respondió: no se sabe qué citas hubo, y "nada pendiente" mentiría. */
  sinAgenda: boolean;
}) {
  return (
    <Card padded={false}>
      <CardHead
        title={
          sinAgenda
            ? "Pendientes"
            : pendientes.length === 0
              ? "Nada pendiente"
              : `${pendientes.length} ${pendientes.length === 1 ? "pendiente" : "pendientes"}`
        }
      />
      <div style={{ padding: "0 1rem 1rem" }}>
        {sinAgenda ? (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            La agenda no respondió, así que no se puede saber si quedó alguna cita sin cobrar. Lo
            cobrado se ve abajo y se sincroniza igual.
          </p>
        ) : pendientes.length === 0 ? (
          <EmptyState
            icon="check"
            title="Todo lo atendido está cobrado"
            body="No queda ninguna cita atendida sin cuenta. Lo cobrado llega solo a Actual."
          />
        ) : (
          <>
            <p
              style={{
                margin: "0 0 0.75rem",
                fontSize: "var(--text-xs)",
                color: "var(--color-ink-soft)",
              }}
            >
              No frenan nada: lo demás del día ya viaja solo. Cada una se resuelve desde{" "}
              <Link href={`/hoy?fecha=${date}`}>Hoy, en este día</Link>, y en cuanto se cobre sale
              en la próxima sincronización.
            </p>
            <DataTable
              columns={ISSUE_COLUMNS}
              rows={pendientes}
              rowKey={(row) => String(row.eaAppointmentId)}
              caption="Citas atendidas sin cobrar o con la cuenta incompleta"
            />
          </>
        )}

        {enCurso.length === 0 ? null : (
          <details style={{ marginTop: "0.875rem" }}>
            <summary style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
              {enCurso.length} {enCurso.length === 1 ? "cita" : "citas"} todavía en curso
            </summary>
            <div style={{ marginTop: "0.5rem" }}>
              <DataTable
                columns={ISSUE_COLUMNS}
                rows={enCurso}
                rowKey={(row) => String(row.eaAppointmentId)}
                caption="Citas del día que todavía no terminaron"
              />
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

// ── Totales ─────────────────────────────────────────────────────────────────

function Totales({ totals }: { totals: DayTotals }) {
  return (
    <Card padded={false}>
      <CardHead title="Cuadre del día" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.875rem" }}>
        <div>
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-2xs)",
              color: "var(--color-ink-soft)",
            }}
          >
            Ingreso del día
          </p>
          {/* Figuras proporcionales: es un número solo, no una columna. */}
          <p
            style={{
              margin: "0.125rem 0 0",
              fontSize: "var(--text-xl)",
              lineHeight: "var(--text-xl--line-height)",
              color: "var(--color-carbon)",
              fontWeight: 600,
            }}
          >
            {formatCOP(totals.ingreso)}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(6.25rem, 1fr))",
            paddingTop: "0.875rem",
            borderTop: "1px solid var(--color-ivory-deep)",
          }}
        >
          <Tile label="Efectivo" value={formatCOP(totals.efectivo)} />
          <Tile label="Transferencia" value={formatCOP(totals.transferencia)} />
          <Tile label="Otro" value={formatCOP(totals.otro)} />
        </div>

        {totals.sinMetodo === 0 ? null : (
          <p
            role="status"
            style={{
              margin: 0,
              display: "flex",
              gap: "0.5rem",
              padding: "0.625rem 0.75rem",
              borderRadius: "var(--radius-md)",
              background: "var(--color-warn-tint)",
              border: "1px solid var(--color-warn-line)",
              color: "var(--color-warn-ink)",
              fontSize: "var(--text-xs)",
            }}
          >
            <Icon name="alerta" size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              <strong className="ui-num">{formatCOP(totals.sinMetodo)}</strong> cobrados sin método
              de pago asignado. Esa plata no entra a ninguna columna ni viaja a Actual hasta que
              alguien elija el método desde Hoy.
            </span>
          </p>
        )}

        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(6.25rem, 1fr))",
            paddingTop: "0.875rem",
            borderTop: "1px solid var(--color-ivory-deep)",
          }}
        >
          {/* La propina va aparte y nunca entra al ingreso ni a la base de
              comisión: es de la técnica, no del estudio. */}
          <Tile label="Propinas (aparte)" value={formatCOP(totals.tips)} />
          <Tile label="Cuentas cerradas" value={String(totals.count)} />
          {/* Las cortesías de la casa no entran a ningún total: se cuentan
              aparte para que el número de cuentas cuadre con la lista. */}
          {totals.cortesias === 0 ? null : (
            <Tile label="Cortesías (fuera de caja)" value={String(totals.cortesias)} />
          )}
        </div>
      </div>
    </Card>
  );
}

/** Un tile de cifra. Etiqueta arriba, valor abajo, sin adornos. */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
        {label}
      </p>
      <p
        className="ui-num"
        style={{
          margin: "0.125rem 0 0",
          fontSize: "var(--text-md)",
          color: "var(--color-carbon)",
        }}
      >
        {value}
      </p>
    </div>
  );
}

// ── Cuentas cerradas ────────────────────────────────────────────────────────

const METHOD_LABEL: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  otro: "Otro",
};

/**
 * Con qué se pagó la cuenta, en una celda.
 *
 * Con un solo método basta el nombre. **Con dos van los montos**, aunque la
 * celda crezca: quien mira esta columna está cuadrando el cajón contra la
 * pantalla, y "Efectivo + Transferencia" sin cifras no le sirve para saber
 * cuánto efectivo debería estar contando.
 */
function describeMethods(row: DayAccount): string {
  // No es un método: es que no se cobró, a propósito. "Sin método" la pintaría
  // como un pendiente que recepción tiene que reclamar.
  if (row.houseCourtesy === true) return "Cortesía de la casa";
  if (row.payments.length === 0) return "Sin método";
  if (row.payments.length === 1) return METHOD_LABEL[row.payments[0].method];

  return row.payments
    .map((payment) => `${METHOD_LABEL[payment.method]} ${formatPesos(payment.amount)}`)
    .join(" + ");
}

/**
 * Las columnas de las cuentas cerradas, con el nombre de la clienta resuelto.
 *
 * Son una función y no una constante porque `DayAccount` viene de `gbs_admin` y
 * no tiene nombre de clienta —es la forma que viaja al push, y ahí un nombre no
 * tiene nada que hacer—, así que el nombre se cruza con las citas de EA por
 * `ea_appointment_id`. Una lista que dice "#101" no le sirve a nadie para
 * cuadrar la caja.
 */
function accountColumns(
  nombres: ReadonlyMap<number, string>,
): ReadonlyArray<Column<DayAccount>> {
  const nombre = (row: DayAccount) =>
    nombres.get(row.eaAppointmentId) ?? `Cita #${row.eaAppointmentId}`;

  return [
  {
    key: "clienta",
    header: "Cliente",
    from: "siempre",
    listSlot: "primary",
    render: nombre,
    text: nombre,
  },
  {
    key: "metodo",
    header: "Método",
    from: "siempre",
    listSlot: "secondary",
    render: (row) => describeMethods(row),
    text: (row) => describeMethods(row),
  },
  {
    key: "push",
    header: "En Actual",
    from: "md",
    listSlot: "oculto",
    render: (row) => syncLabel(row),
    text: (row) => syncLabel(row),
  },
  // `formatPesos` y no `formatCOP` en las columnas: el encabezado ya dice que
  // la columna es plata, y repetir el `$` treinta veces solo agrega ruido.
  {
    key: "propina",
    header: "Propina",
    from: "md",
    numeric: true,
    align: "end",
    listSlot: "oculto",
    render: (row) => formatPesos(row.tip),
    text: (row) => formatPesos(row.tip),
  },
  {
    key: "cobrado",
    header: "Cobrado",
    from: "siempre",
    numeric: true,
    align: "end",
    listSlot: "trailing",
    render: (row) => (row.amountCharged === null ? "—" : formatPesos(row.amountCharged)),
    text: (row) => (row.amountCharged === null ? "—" : formatPesos(row.amountCharged)),
  },
  ];
}

/**
 * Si la cuenta ya viajó. "Esta noche" y no "No": una cuenta cobrada que todavía
 * no salió no está atrasada, está esperando su turno. Una cortesía no viaja —no
 * hubo plata—, y una cuenta sin método no puede viajar hasta que se complete.
 */
function syncLabel(row: DayAccount): string {
  if (row.houseCourtesy === true) return "No aplica";
  if (row.pushedToIngestAt !== null) return "Sí";
  if (row.payments.length === 0) return "Falta el método";
  return "Esta noche";
}

function Cerradas({
  accounts,
  nombres,
}: {
  accounts: readonly DayAccount[];
  nombres: ReadonlyMap<number, string>;
}) {
  return (
    <Card padded={false}>
      <CardHead title="Cuentas cobradas" />
      <div style={{ padding: "0 1rem 1rem" }}>
        <DataTable
          columns={accountColumns(nombres)}
          rows={accounts}
          rowKey={(row) => String(row.financeId)}
          caption="Cuentas cobradas del día"
          empty={
            <EmptyState
              icon="caja"
              title="Todavía no hay ninguna cuenta cobrada"
              body="Las cuentas las cierra cada profesional desde Hoy, al terminar el servicio. Acá aparecen a medida que entran."
            />
          }
        />
      </div>
    </Card>
  );
}

// ── Sincronización ──────────────────────────────────────────────────────────

/**
 * Qué del día ya está en Actual, y qué sale esta noche.
 *
 * El botón no es un cierre: manda lo que ya está cobrado, igual que la noche.
 * Se ofrece solo si hay algo que mandar.
 */
function Sincronizacion({ view }: { view: CajaView }) {
  const { review, unsynced, pushEnabled, date, cutover } = view;
  // Un día de antes del corte nunca se envía: su plata entró por Agenda Pro.
  const antesDelCorte = cutover != null && date < cutover;
  const enviadas = review.closed.filter(
    (account) => account.houseCourtesy !== true && account.pushedToIngestAt !== null,
  ).length;
  const listas = unsynced.filter((account) => account.payments.length > 0).length;

  return (
    <Card padded={false}>
      <CardHead title="Actual Budget" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem" }}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-carbon)" }}>
          {antesDelCorte
            ? "Este día es anterior al corte de Agenda Pro: esa plata entró a Actual por allá y no se manda."
            : review.closed.length === 0
              ? "Todavía no hay nada cobrado en este día."
              : listas === 0
                ? enviadas === 0
                  ? "No hay cuentas que enviar."
                  : "Todo lo cobrado de este día ya está en Actual."
                : `${enviadas === 0 ? "" : `${enviadas} ${enviadas === 1 ? "cuenta ya está" : "cuentas ya están"} en Actual. `}${
                    listas === 1 ? "1 cuenta sale" : `${listas} cuentas salen`
                  } solas esta noche.`}
        </p>
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          No hay que cerrar el día. Si corriges una cuenta que ya está en Actual, la diferencia viaja
          sola como ajuste.
        </p>

        {pushEnabled ? null : (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            El envío al CRM está apagado (falta <code>INGEST_URL</code>). Las cuentas quedan listas y
            salen con las mismas llaves cuando se configure.
          </p>
        )}

        {listas === 0 || antesDelCorte || !pushEnabled ? null : (
          <div>
            <SincronizarAhora fecha={date} cuentas={listas} />
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Cierres que no llegaron al CRM ──────────────────────────────────────────

/**
 * Días cuyo envío al CRM falló.
 *
 * La sincronización de cada noche los reintenta sola, con las mismas llaves.
 * Se muestran igual porque un envío que falló en silencio es exactamente igual
 * a no haber enviado, y quien mira Caja es quien va a notar que un día falta
 * en Actual Budget.
 */
function SinEmpujar({
  rows,
  pushEnabled,
}: {
  rows: readonly { id: number; close_date: string }[];
  pushEnabled: boolean;
}) {
  return (
    <Card padded={false}>
      <CardHead title="Días que no llegaron al CRM" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.5rem" }}>
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          {pushEnabled
            ? "Se reintentan solos cada noche con las mismas llaves, así que no pueden duplicar movimientos. Desde su día también se pueden sincronizar ahora."
            : "El envío está apagado. Estos días esperan a que INGEST_URL esté configurada."}
        </p>
        <ul style={{ margin: 0, paddingLeft: "1.125rem", fontSize: "var(--text-sm)" }}>
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/caja?fecha=${row.close_date}`}>{row.close_date}</Link>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
