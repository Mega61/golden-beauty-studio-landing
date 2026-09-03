import Link from "next/link";

import {
  Card,
  CardHead,
  DataTable,
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

import { CierreDelDia, ReintentarPush } from "./CajaAcciones";
import type { CajaView } from "./data";

/**
 * **Caja** — el día completo: pendientes, totales por método y el cierre.
 *
 * ## El orden de la pantalla es la funcionalidad
 *
 * Los pendientes van **arriba**, antes de los totales. No es jerarquía visual
 * por gusto: la lista de pendientes *es* la compuerta del cierre hecha visible,
 * y vaciarla es el trabajo de la recepción. Un total del día arriba y los
 * pendientes al fondo invitaría a leer una cifra que todavía está incompleta.
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
 * ella; el sistema de diseño manda sobre el default de la skill. Va con figuras
 * proporcionales —sin `.ui-num`— que es lo correcto para un número solo;
 * `tabular-nums` queda para las columnas de las tablas, donde los dígitos tienen
 * que alinearse.
 *
 * ## En móvil se consulta, no se cierra
 *
 * El plan lo fija: "el cierre solo desde tablet o escritorio". Pero **la lista
 * de pendientes se consulta desde el celular** a media tarde, así que la
 * pantalla entera funciona a 390 px y lo único que desaparece es el botón, con
 * una línea que dice dónde está.
 */
export function CajaVista({ view }: { view: CajaView }) {
  const { review, dayClose, pendingPush, pushEnabled, date, today } = view;
  const bloquean = review.issues.filter((i) => i.blocks);
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
        bloquean={bloquean}
        enCurso={enCurso}
        cerrado={dayClose !== null}
        bloqueadoAparte={review.blockers.length > 0}
      />

      <Totales totals={review.totals} cerrado={dayClose !== null} />

      <Cerradas accounts={review.closed} nombres={nombres} />

      <Cierre view={view} bloquean={bloquean.length} />

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
 * Existe porque el reintento del push tiene que poder apuntar a ayer: un cierre
 * que salió pero cuyo push falló se arregla desde su propio día, no desde hoy.
 * Son enlaces y no un control con estado — la pantalla es un Server Component y
 * navegar es lo que ya sabe hacer.
 */
function Fecha({ date, today }: { date: string; today: string }) {
  const anterior = shiftDate(date, -1);
  const siguiente = shiftDate(date, 1);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: "var(--text-2xs)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-ink-soft)",
        }}
      >
        {formatDateLong(`${date} 00:00:00`)}
        {date === today ? "" : " · día anterior"}
      </p>
      <nav
        aria-label="Cambiar de día"
        style={{ display: "flex", gap: "0.75rem", fontSize: "var(--text-2xs)" }}
      >
        <Link href={`/caja?fecha=${anterior}`}>← {anterior}</Link>
        {date === today ? null : <Link href="/caja">Hoy</Link>}
        {siguiente > today ? null : (
          <Link href={`/caja?fecha=${siguiente}`}>{siguiente} →</Link>
        )}
      </nav>
    </div>
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
    header: "Clienta",
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
  bloquean,
  enCurso,
  cerrado,
  bloqueadoAparte,
}: {
  bloquean: readonly DayIssue[];
  enCurso: readonly DayIssue[];
  cerrado: boolean;
  /**
   * Hay un impedimento que **no** es una cuenta pendiente: la agenda no
   * responde, un total quedó negativo.
   *
   * Sin esto el vacío decía "el día se puede cerrar" justo debajo de la banda
   * que dice que no. Dos frases contradictorias en la misma pantalla y la que
   * el ojo lee primero es la equivocada.
   */
  bloqueadoAparte: boolean;
}) {
  return (
    <Card padded={false}>
      <CardHead
        title={
          bloquean.length === 0
            ? "Nada pendiente"
            : `${bloquean.length} ${bloquean.length === 1 ? "cuenta pendiente" : "cuentas pendientes"}`
        }
      />
      <div style={{ padding: "0 1rem 1rem" }}>
        {bloquean.length === 0 ? (
          <EmptyState
            icon="check"
            title={cerrado ? "El día está cerrado" : "Todas las cuentas del día están cerradas"}
            body={
              cerrado
                ? "Las cuentas de este día ya están congeladas bajo su cierre. Corregir una exige un ajuste."
                : bloqueadoAparte
                  ? "No queda ninguna cita atendida sin cuenta, pero el cierre sigue bloqueado por otro motivo: está explicado abajo, en Cierre del día."
                  : "No queda ninguna cita atendida sin cuenta. El día se puede cerrar."
            }
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
              Mientras quede una, el día no se puede cerrar. Cada una se resuelve desde{" "}
              <Link href="/hoy">Hoy</Link>, cerrando su cuenta.
            </p>
            <DataTable
              columns={ISSUE_COLUMNS}
              rows={bloquean}
              rowKey={(row) => String(row.eaAppointmentId)}
              caption="Citas atendidas sin cuenta cerrada"
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

function Totales({ totals, cerrado }: { totals: DayTotals; cerrado: boolean }) {
  return (
    <Card padded={false}>
      <CardHead title={cerrado ? "Totales del cierre" : "Totales de lo cerrado" } />
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
              de pago asignado. Esa plata no entra a ninguna columna y el día no cierra hasta que
              alguien la registre.
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
    header: "Clienta",
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
    render: (row) =>
      row.paymentMethod === null ? "Sin método" : METHOD_LABEL[row.paymentMethod],
    text: (row) => (row.paymentMethod === null ? "Sin método" : METHOD_LABEL[row.paymentMethod]),
  },
  {
    key: "push",
    header: "En el CRM",
    from: "lg",
    listSlot: "oculto",
    render: (row) => (row.pushedToIngestAt === null ? "No" : "Sí"),
    text: (row) => (row.pushedToIngestAt === null ? "No" : "Sí"),
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

function Cerradas({
  accounts,
  nombres,
}: {
  accounts: readonly DayAccount[];
  nombres: ReadonlyMap<number, string>;
}) {
  return (
    <Card padded={false}>
      <CardHead title="Cuentas cerradas" />
      <div style={{ padding: "0 1rem 1rem" }}>
        <DataTable
          columns={accountColumns(nombres)}
          rows={accounts}
          rowKey={(row) => String(row.financeId)}
          caption="Cuentas cerradas del día"
          empty={
            <EmptyState
              icon="caja"
              title="Todavía no hay ninguna cuenta cerrada"
              body="Las cuentas las cierra cada técnica desde Hoy, al terminar el servicio. Acá aparecen a medida que entran."
            />
          }
        />
      </div>
    </Card>
  );
}

// ── El cierre ───────────────────────────────────────────────────────────────

function Cierre({ view, bloquean }: { view: CajaView; bloquean: number }) {
  const { dayClose, review, pushEnabled, date } = view;

  return (
    <Card padded={false}>
      <CardHead title="Cierre del día" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem" }}>
        {review.blockers.map((blocker) => (
          <p
            key={blocker}
            role="alert"
            style={{
              margin: 0,
              display: "flex",
              gap: "0.5rem",
              padding: "0.625rem 0.75rem",
              borderRadius: "var(--radius-md)",
              background: "var(--color-error-tint)",
              border: "1px solid var(--color-error-line)",
              color: "var(--color-error-ink)",
              fontSize: "var(--text-xs)",
            }}
          >
            <Icon name="alerta" size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>{blocker}</span>
          </p>
        ))}

        {dayClose === null ? null : (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            Cerrado el {formatDateLong(`${date} 00:00:00`)}.{" "}
            {dayClose.pushed_to_ingest_at === null
              ? "El lote todavía no llegó al CRM."
              : "El lote ya se empujó al CRM."}
          </p>
        )}

        {pushEnabled ? null : (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            El push al CRM está apagado (falta <code>INGEST_URL</code>). El día se cierra igual y el
            lote queda pendiente: cuando la variable esté puesta, se empuja con el mismo lote y las
            mismas llaves.
          </p>
        )}

        {/* El cierre solo desde tablet o escritorio (§ Navegación y pantallas).
            En el celular la pantalla sigue siendo útil —los pendientes son lo
            que se consulta de pie— y solo se dice dónde está el botón. */}
        <div className="ui-only-sm">
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            El cierre del día se hace desde la tablet o el computador.
          </p>
        </div>
        <div className="ui-only-md">
          {dayClose === null ? (
            <>
              <CierreDelDia
                fecha={date}
                bloqueado={bloquean > 0 || review.blockers.length > 0}
                cuentas={review.totals.count}
              />
              {/* Un control deshabilitado sin el motivo al lado obliga a
                  adivinar. El motivo está arriba, en la lista de pendientes,
                  pero "arriba" no es "acá". */}
              {bloquean === 0 ? null : (
                <p
                  style={{
                    margin: "0.5rem 0 0",
                    fontSize: "var(--text-xs)",
                    color: "var(--color-ink-soft)",
                  }}
                >
                  {bloquean === 1
                    ? "Falta una cuenta por resolver."
                    : `Faltan ${bloquean} cuentas por resolver.`}
                </p>
              )}
            </>
          ) : dayClose.pushed_to_ingest_at === null && pushEnabled ? (
            <ReintentarPush fecha={date} />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

// ── Cierres que no llegaron al CRM ──────────────────────────────────────────

/**
 * Días ya cerrados cuyo lote no llegó a ingest.
 *
 * Un push que falló en silencio es exactamente igual a no haber empujado, así
 * que se muestra acá y no solo en Diagnóstico: quien cierra la caja es quien va
 * a notar que un día falta en Actual Budget.
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
      <CardHead title="Cierres que no llegaron al CRM" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.5rem" }}>
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          {pushEnabled
            ? "Reintentar manda el mismo lote con las mismas llaves: no puede duplicar movimientos."
            : "El push está apagado. Estos días esperan a que INGEST_URL esté configurada."}
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
