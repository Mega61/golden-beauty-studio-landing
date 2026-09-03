import Link from "next/link";

import {
  Card,
  CardHead,
  DataTable,
  EmptyState,
  Icon,
  formatCOP,
  formatDateLong,
  formatDateShort,
  formatPesos,
  type Column,
} from "@/components/ui";
import type { CommissionRunStatus } from "@/db/types";

import { describeBlocker } from "./blockers";
import { LiquidarQuincena, MarcarPagada, MarcarRevisada } from "./ComisionesAcciones";
import type { ComisionesView, PendingAccount } from "./data";
import type { ProviderSettlement, SettlementAppointment } from "./settlement";

/**
 * **Comisiones** — cuánto se le paga a cada técnica esta quincena.
 *
 * ## El orden de la pantalla es la pregunta
 *
 * La dueña llega el 15 con una sola pregunta: *cuánto le pago a cada una*. Así
 * que arriba va el total de la quincena y, pegado, una tarjeta por técnica con
 * su cifra grande. El desglose por cita está a un clic —dentro de un
 * `<details>` cerrado— porque revisar es el segundo movimiento, no el primero:
 * abrirlo por defecto empujaría la respuesta fuera de la pantalla y obligaría a
 * bajar para leer un número que ya estaba calculado.
 *
 * Lo que queda **arriba de la cifra** son los bloqueos, cuando hay: una
 * quincena con tres días de caja sin cerrar no se puede pagar, y enterarse de
 * eso después de leer el total es enterarse tarde.
 *
 * ## Por qué no hay ningún gráfico
 *
 * Dos o tres cifras que se leen exactas —"¿cuánto le pago a Lina?"— son una
 * **fila de cifras**, no un gráfico de barras de tres barras; es literalmente
 * el heurístico de forma de la skill `dataviz` ("a handful of headline numbers
 * → KPI row"). Y como no hay series, no se asigna ni un color categórico. El
 * dorado del sistema es acción y foco: acá está en el botón de calcular y en el
 * de pagar, y en ningún dato.
 *
 * La cifra grande usa `--text-xl` (24 px), que es el techo de la escala de este
 * panel, con figuras proporcionales; `tabular-nums` (`.ui-num`) queda para las
 * columnas, donde los dígitos tienen que alinearse.
 *
 * ## En el celular se consulta
 *
 * La pantalla entera funciona a 390 px: la técnica abre su liquidación desde el
 * teléfono y la tabla del desglose colapsa a lista de dos líneas, sin scroll
 * lateral. Los botones de la dueña se muestran igual — no hay razón para
 * esconderlos: liquidar es idempotente y pagar pide confirmación con el monto a
 * la vista.
 */
export function ComisionesVista({ view }: { view: ComisionesView }) {
  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Quincena view={view} />

      {view.eaFailure === null ? null : <Aviso tone="warn" text={view.eaFailure} />}

      {view.unlinked ? (
        <Card>
          <EmptyState
            icon="candado"
            title="Tu cuenta todavía no está enlazada a tu agenda"
            body="Sin ese enlace no hay forma de saber cuál liquidación es la tuya. La dueña lo conecta desde Equipo."
          />
        </Card>
      ) : (
        <>
          <Resumen view={view} />
          {view.settlements.map((settlement) => (
            <Liquidacion
              key={settlement.eaProviderId}
              settlement={settlement}
              view={view}
            />
          ))}
          {view.settlements.length === 0 ? <SinLiquidar view={view} /> : null}
          {view.pending.length === 0 || view.settlements.length === 0 ? null : (
            <SinComision rows={view.pending} />
          )}
        </>
      )}
    </div>
  );
}

// ── La quincena que se está mirando ─────────────────────────────────────────

/**
 * El periodo y cómo moverse.
 *
 * Son enlaces y no un control con estado: la pantalla es un Server Component y
 * navegar es lo que ya sabe hacer. El enlace de la quincena siguiente
 * desaparece cuando esa quincena todavía no empezó — ofrecerlo sería ofrecer
 * una pantalla vacía.
 */
function Quincena({ view }: { view: ComisionesView }) {
  const { period, current, previous, next } = view;
  const esActual = period.periodStart === current.periodStart;

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
        {formatDateLong(`${period.periodStart} 00:00:00`)} –{" "}
        {formatDateLong(`${period.periodEnd} 00:00:00`, true)}
        {esActual ? " · en curso" : ""}
      </p>
      <nav
        aria-label="Cambiar de quincena"
        style={{ display: "flex", gap: "0.75rem", fontSize: "var(--text-2xs)" }}
      >
        <Link href={`/comisiones?quincena=${previous.periodStart}`}>
          ← {formatDateShort(`${previous.periodStart} 00:00:00`)}
        </Link>
        {esActual ? null : <Link href="/comisiones">Esta quincena</Link>}
        {next === null ? null : (
          <Link href={`/comisiones?quincena=${next.periodStart}`}>
            {formatDateShort(`${next.periodStart} 00:00:00`)} →
          </Link>
        )}
      </nav>
    </div>
  );
}

// ── El total y la compuerta ─────────────────────────────────────────────────

function Resumen({ view }: { view: ComisionesView }) {
  const { total, base, settlements, blockers, canAdmin, period, scope } = view;
  const pagadas = settlements.filter((s) => s.status === "pagada").length;

  return (
    <Card padded={false}>
      <CardHead
        title={scope === "propia" ? "Tu liquidación" : "Comisiones de la quincena"}
      />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.875rem" }}>
        {blockers.length === 0 ? null : (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {blockers.map((blocker) => (
              <Aviso key={blocker.kind} tone="warn" text={describeBlocker(blocker)} />
            ))}
          </div>
        )}

        <div>
          <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            {scope === "propia" ? "Tu comisión" : "Total a pagar en comisiones"}
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
            {formatCOP(total)}
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
          <Cifra label="Sobre lo cobrado" value={formatCOP(base)} />
          <Cifra
            label={settlements.length === 1 ? "Técnica" : "Técnicas"}
            value={String(settlements.length)}
          />
          <Cifra label="Ya pagadas" value={`${pagadas} de ${settlements.length}`} />
        </div>

        {canAdmin ? (
          <div style={{ paddingTop: "0.875rem", borderTop: "1px solid var(--color-ivory-deep)" }}>
            <LiquidarQuincena quincena={period.periodStart} ya={settlements.length > 0} />
            <p
              style={{
                margin: "0.5rem 0 0",
                fontSize: "var(--text-xs)",
                color: "var(--color-ink-soft)",
              }}
            >
              Calcular de nuevo reescribe los borradores con lo que hoy dicen las cuentas
              cerradas. Las quincenas ya pagadas no se tocan.
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Una cifra con su etiqueta. Etiqueta arriba, valor abajo, sin adornos. */
function Cifra({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
        {label}
      </p>
      <p
        className="ui-num"
        style={{ margin: "0.125rem 0 0", fontSize: "var(--text-md)", color: "var(--color-carbon)" }}
      >
        {value}
      </p>
    </div>
  );
}

// ── Una técnica ─────────────────────────────────────────────────────────────

const ESTADO: Record<CommissionRunStatus, { label: string; tint: string; line: string; ink: string }> = {
  borrador: {
    label: "Borrador",
    tint: "var(--color-cream)",
    line: "var(--hair-strong)",
    ink: "var(--color-ink-soft)",
  },
  revisada: {
    label: "Revisada",
    tint: "var(--color-info-tint)",
    line: "var(--color-info-line)",
    ink: "var(--color-info-ink)",
  },
  pagada: {
    label: "Pagada",
    tint: "var(--color-ok-tint)",
    line: "var(--color-ok-line)",
    ink: "var(--color-ok-ink)",
  },
};

/**
 * La pastilla de estado de la liquidación.
 *
 * Nunca color solo: superficie tintada, filete de 1 px y **texto**, la misma
 * regla que `StatusPill` (que no se reusa porque su vocabulario es el de los
 * estados de la cita, no el de la liquidación). Nada de franja lateral, y nada
 * de dorado: el dorado es acción, no dato.
 */
function EstadoPill({ status }: { status: CommissionRunStatus | null }) {
  const meta =
    status === null
      ? {
          label: "Sin calcular",
          tint: "transparent",
          line: "var(--hair-strong)",
          ink: "var(--color-ink-soft)",
        }
      : ESTADO[status];

  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.0625rem 0.4375rem",
        borderRadius: "var(--radius-sm)",
        background: meta.tint,
        border: `1px solid ${meta.line}`,
        color: meta.ink,
        fontSize: "var(--text-2xs)",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

function Liquidacion({
  settlement,
  view,
}: {
  settlement: ProviderSettlement;
  view: ComisionesView;
}) {
  const puedeRevisar =
    view.canAdmin && settlement.status === "borrador" && view.blockers.length === 0;
  const puedePagar = view.canAdmin && settlement.status === "revisada";

  return (
    <Card padded={false}>
      <CardHead title={settlement.name} actions={<EstadoPill status={settlement.status} />} />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.875rem" }}>
        <div>
          <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            {settlement.status === "pagada" ? "Pagado" : "A pagar"}
          </p>
          <p
            style={{
              margin: "0.125rem 0 0",
              fontSize: "var(--text-xl)",
              lineHeight: "var(--text-xl--line-height)",
              color: "var(--color-carbon)",
              fontWeight: 600,
            }}
          >
            {formatCOP(settlement.amount)}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gap: "0.75rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(6.25rem, 1fr))",
          }}
        >
          <Cifra label="Sobre lo cobrado" value={formatCOP(settlement.base)} />
          <Cifra
            label={settlement.appointments === 1 ? "Cita" : "Citas"}
            value={String(settlement.appointments)}
          />
          {settlement.flagged === 0 ? null : (
            <Cifra label="Renglones marcados" value={String(settlement.flagged)} />
          )}
        </div>

        {settlement.stale && settlement.runTotal !== null ? (
          <Aviso
            tone="warn"
            text={`La liquidación guardada dice ${formatCOP(settlement.runTotal)} y las cuentas de hoy dan ${formatCOP(settlement.amount)}. Vuelve a calcular la quincena antes de pagar.`}
          />
        ) : null}

        {settlement.flagged === 0 ? null : (
          <Aviso
            tone="warn"
            text={
              settlement.flagged === 1
                ? "Un renglón quedó con comisión en cero porque ninguna regla le aplica. Está marcado en el desglose."
                : `${settlement.flagged} renglones quedaron con comisión en cero porque ninguna regla les aplica. Están marcados en el desglose.`
            }
          />
        )}

        <Desglose settlement={settlement} />

        {view.canAdmin ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              paddingTop: "0.875rem",
              borderTop: "1px solid var(--color-ivory-deep)",
            }}
          >
            {settlement.status === "pagada" ? (
              <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
                Esta quincena está pagada y cerrada. Una corrección posterior entra en la
                quincena siguiente, nunca reescribiendo ésta.
              </p>
            ) : settlement.status === "revisada" ? (
              <MarcarPagada
                quincena={view.period.periodStart}
                eaProviderId={settlement.eaProviderId}
                monto={formatCOP(settlement.amount)}
                bloqueado={!puedePagar}
              />
            ) : (
              <>
                <MarcarRevisada
                  quincena={view.period.periodStart}
                  eaProviderId={settlement.eaProviderId}
                  bloqueado={!puedeRevisar}
                />
                {puedeRevisar ? null : (
                  <p
                    style={{
                      margin: 0,
                      flexBasis: "100%",
                      fontSize: "var(--text-xs)",
                      color: "var(--color-ink-soft)",
                    }}
                  >
                    {settlement.status === null
                      ? "Primero hay que calcular la quincena."
                      : "Falta cerrar lo que aparece arriba antes de poder revisarla."}
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ── El desglose por cita ────────────────────────────────────────────────────

/** `"2026-09-02"` → `"2 sep"`. `null` cuando la cuenta no tenía fecha. */
function diaCorto(date: string | null): string {
  return date === null ? "—" : formatDateShort(`${date} 00:00:00`);
}

/** El rótulo de la fila: el primer servicio y cuántos más. */
function tituloCita(cita: SettlementAppointment): string {
  const [primera, ...resto] = cita.lines;
  if (primera === undefined) return `Cita #${cita.eaAppointmentId}`;
  return resto.length === 0 ? primera.label : `${primera.label} +${resto.length}`;
}

/** Los renglones, en una línea: "Forrado · Diseño por uña ×3". */
function renglones(cita: SettlementAppointment): string {
  return cita.lines
    .map((line) => (line.qty > 1 ? `${line.label} ×${line.qty}` : line.label))
    .join(" · ");
}

/** La tasa de la cita, si todos sus renglones pagaron la misma. */
function tasa(cita: SettlementAppointment): string {
  const tasas = new Set(cita.lines.map((line) => line.rateBp));
  if (tasas.size !== 1) return "mixta";
  const [única] = [...tasas];
  // Punto básico → porcentaje, solo para pintarlo. 4000 → "40 %".
  return única === null ? "—" : `${única / 100} %`;
}

const COLUMNAS: ReadonlyArray<Column<SettlementAppointment>> = [
  {
    key: "cita",
    header: "Cita",
    from: "siempre",
    listSlot: "primary",
    render: (cita) => (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
        {cita.flagged ? (
          <Icon
            name="alerta"
            size={14}
            style={{ flex: "none", color: "var(--color-warn-ink)" }}
            title="Tiene un renglón sin regla de comisión"
          />
        ) : null}
        {tituloCita(cita)}
      </span>
    ),
    text: tituloCita,
  },
  {
    key: "fecha",
    header: "Día",
    from: "siempre",
    listSlot: "secondary",
    width: "6rem",
    // `text` y `render` dicen lo mismo a propósito: la lista de dos líneas del
    // móvil se arma con `text`, y si acá quedara la fecha cruda, el celular
    // mostraría `2026-09-02` donde la tabla dice "2 sep".
    render: (cita) => diaCorto(cita.date),
    text: (cita) => diaCorto(cita.date),
  },
  // La segunda línea de la lista móvil es **una sola línea con elipsis**, así
  // que el detalle de renglones se queda para la tabla: metido ahí adentro, lo
  // que se recorta es justo el día.
  {
    key: "renglones",
    header: "Renglones",
    from: "md",
    listSlot: "oculto",
    render: renglones,
    text: renglones,
  },
  {
    key: "tasa",
    header: "Tasa",
    from: "lg",
    listSlot: "oculto",
    align: "end",
    numeric: true,
    width: "5rem",
    render: tasa,
    text: tasa,
  },
  // `formatPesos` y no `formatCOP` en las columnas: el encabezado ya dice que la
  // columna es plata, y repetir el `$` treinta veces solo agrega ruido.
  {
    key: "base",
    header: "Cobrado",
    from: "md",
    listSlot: "oculto",
    align: "end",
    numeric: true,
    render: (cita) => formatPesos(cita.base),
    text: (cita) => formatPesos(cita.base),
  },
  {
    key: "comision",
    header: "Comisión",
    from: "siempre",
    listSlot: "trailing",
    align: "end",
    numeric: true,
    render: (cita) => formatPesos(cita.amount),
    text: (cita) => formatPesos(cita.amount),
  },
];

function Desglose({ settlement }: { settlement: ProviderSettlement }) {
  if (settlement.detail.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
        Esta quincena no tiene ninguna cita con comisión.
      </p>
    );
  }

  return (
    <details>
      <summary style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
        {settlement.detail.length === 1
          ? "Ver la cita de esta liquidación"
          : `Ver las ${settlement.detail.length} citas de esta liquidación`}
      </summary>
      <div style={{ marginTop: "0.5rem" }}>
        <DataTable
          columns={COLUMNAS}
          rows={settlement.detail}
          rowKey={(cita) => String(cita.eaAppointmentId)}
          caption={`Citas de ${settlement.name} en la quincena`}
        />
      </div>
    </details>
  );
}

// ── Los dos vacíos ──────────────────────────────────────────────────────────

function SinLiquidar({ view }: { view: ComisionesView }) {
  return (
    <Card>
      <EmptyState
        icon="comisiones"
        title="Esta quincena todavía no se ha calculado"
        body={
          view.canAdmin
            ? "Calcularla lee las cuentas cerradas del periodo y congela la comisión de cada renglón. Se puede volver a calcular tantas veces como haga falta: no duplica nada."
            : "Cuando la dueña la calcule, tu liquidación aparece acá con el desglose por cita."
        }
      />
    </Card>
  );
}

const PENDIENTES: ReadonlyArray<Column<PendingAccount>> = [
  {
    key: "cita",
    header: "Cita",
    from: "siempre",
    listSlot: "primary",
    render: (row) => `Cita #${row.eaAppointmentId}`,
    text: (row) => `Cita #${row.eaAppointmentId}`,
  },
  {
    key: "dia",
    header: "Día",
    from: "siempre",
    listSlot: "secondary",
    width: "6rem",
    render: (row) => diaCorto(row.date),
    text: (row) => diaCorto(row.date),
  },
  {
    key: "tecnica",
    header: "Técnica",
    from: "md",
    listSlot: "secondary",
    render: (row) => row.provider,
    text: (row) => row.provider,
  },
  {
    key: "cobrado",
    header: "Cobrado",
    from: "siempre",
    listSlot: "trailing",
    align: "end",
    numeric: true,
    render: (row) => (row.amountCharged === null ? "—" : formatPesos(row.amountCharged)),
    text: (row) => (row.amountCharged === null ? "—" : formatPesos(row.amountCharged)),
  },
];

/**
 * Cuentas cerradas del periodo que no produjeron ni una comisión.
 *
 * Se muestra porque una cuenta saltada en silencio es exactamente igual a una
 * comisión perdida. Casi siempre son cuentas que no cuadran —el cobrado no es
 * la suma de sus renglones, dos técnicas sin combo que diga cómo repartir— y la
 * lista es por dónde empezar a revisarlas.
 */
function SinComision({ rows }: { rows: readonly PendingAccount[] }) {
  return (
    <Card padded={false}>
      <CardHead
        title={
          rows.length === 1
            ? "Una cuenta cerrada quedó sin comisión"
            : `${rows.length} cuentas cerradas quedaron sin comisión`
        }
      />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem" }}>
        <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          Se cobraron pero no generaron comisión. Suele ser porque la cuenta no cuadra o porque
          la cita tiene dos técnicas y no hay un combo que diga en qué proporción se reparte.
        </p>
        <DataTable
          columns={PENDIENTES}
          rows={rows}
          rowKey={(row) => String(row.eaAppointmentId)}
          caption="Cuentas cerradas del periodo sin comisión calculada"
        />
      </div>
    </Card>
  );
}

// ── Avisos ──────────────────────────────────────────────────────────────────

/**
 * Un aviso de una línea.
 *
 * Superficie tintada + filete de 1 px + icono, la misma familia semántica que
 * usa Caja. Sin franja lateral: el patrón está prohibido en todo el sistema.
 */
function Aviso({ tone, text }: { tone: "warn" | "info"; text: string }) {
  const tint = tone === "warn" ? "warn" : "info";
  return (
    <p
      role="status"
      style={{
        margin: 0,
        display: "flex",
        gap: "0.5rem",
        padding: "0.625rem 0.75rem",
        borderRadius: "var(--radius-md)",
        background: `var(--color-${tint}-tint)`,
        border: `1px solid var(--color-${tint}-line)`,
        color: `var(--color-${tint}-ink)`,
        fontSize: "var(--text-xs)",
      }}
    >
      <Icon name="alerta" size={16} style={{ flex: "none", marginTop: 1 }} />
      <span>{text}</span>
    </p>
  );
}
