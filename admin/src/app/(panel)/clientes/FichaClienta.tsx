import Link from "next/link";

import {
  Card,
  CardHead,
  DataTable,
  EmptyState,
  ReadOnlyBand,
  StatusPill,
  formatCOP,
  formatDateLong,
  formatDateShort,
  formatPhoneCO,
  formatTime,
  type Column,
} from "@/components/ui";

import type { ClientProfile } from "./data";
import type { HistoryEntry } from "./history";

/**
 * La ficha: quién es, cuánto ha venido, y la historia completa.
 *
 * **La historia es una sola lista.** EA y `legacy_appointment` viven en bases
 * distintas y con formas distintas, pero "¿cuándo vino la última vez?" no se
 * puede contestar mirando dos pantallas. La columna "Origen" existe para que se
 * pueda saber de dónde salió cada renglón sin tener que separarlos.
 */
export function FichaClienta({ profile }: { profile: ClientProfile }) {
  const { client, history, historyPartial, failure } = profile;

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {failure ? (
        <ReadOnlyBand
          reason={failure.message}
          detailsHref={failure.transient ? undefined : "/diagnostico"}
        />
      ) : null}

      <p style={{ margin: 0, fontSize: "var(--text-2xs)" }}>
        <Link href="/clientes">← Clientas</Link>
      </p>

      <Card padded={false}>
        <div style={{ padding: "1rem", display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-lg)",
              color: "var(--color-carbon)",
            }}
          >
            {client.name || "Clienta sin nombre"}
          </h2>

          <dl style={dlStyle}>
            <Dato etiqueta="Teléfono">
              {client.phone ? (
                <a href={`tel:${client.phone}`} className="ui-num">
                  {formatPhoneCO(client.phone)}
                </a>
              ) : (
                <span style={{ color: "var(--color-ink-soft)" }}>
                  Sin teléfono — esta ficha no se puede unificar con otras
                </span>
              )}
            </Dato>

            <Dato etiqueta="Correo">
              {client.email ? (
                <a href={`mailto:${client.email}`}>{client.email}</a>
              ) : (
                <span style={{ color: "var(--color-ink-soft)" }}>
                  Sin correo
                  {client.suspiciousEmails.length > 0
                    ? ""
                    : " — y así está bien, no se inventa ninguno"}
                </span>
              )}
            </Dato>

            {client.eaCustomerIds.length > 0 ? (
              <Dato etiqueta="Fichas en la agenda">
                <span className="ui-num">{client.eaCustomerIds.join(" · ")}</span>
              </Dato>
            ) : null}

            {client.notes ? <Dato etiqueta="Notas">{client.notes}</Dato> : null}
          </dl>

          {client.merged ? (
            <Aviso tono="warn">
              Esta clienta tiene <strong>{client.eaCustomerIds.length} fichas</strong> en
              Easy!Appointments con el mismo teléfono. El panel las muestra como
              una sola; la agenda sigue viéndolas separadas hasta que alguien las
              una allá.
            </Aviso>
          ) : null}

          {client.suspiciousEmails.length > 0 ? (
            <Aviso tono="warn">
              Hay un correo que parece de relleno:{" "}
              <span className="ui-num">{client.suspiciousEmails.join(", ")}</span>. No se
              usa para nada y conviene borrarlo en la agenda — un correo falso
              viaja como invitado del evento de Google y rebota.
            </Aviso>
          ) : null}
        </div>
      </Card>

      <Resumen profile={profile} />

      <Card padded={false}>
        <CardHead title="Historia" />
        <div style={{ padding: "0 1rem 1rem" }}>
          {historyPartial ? (
            <p style={{ ...metaStyle, marginBottom: "0.5rem" }}>
              Falta la parte que vive en la agenda: solo se está mostrando el
              histórico anterior al corte.
            </p>
          ) : null}
          <DataTable
            columns={historyColumns()}
            rows={history.entries}
            rowKey={(row) => row.id}
            caption="Historia de citas"
            empty={
              <EmptyState
                icon="agenda"
                title="Todavía no tiene citas"
                body="Cuando venga por primera vez, la cita va a aparecer acá junto con lo que se cobró."
              />
            }
          />
        </div>
      </Card>
    </div>
  );
}

function Resumen({ profile }: { profile: ClientProfile }) {
  const { summary } = profile.history;

  return (
    <div
      style={{
        display: "grid",
        gap: "0.75rem",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(9.5rem, 100%), 1fr))",
      }}
    >
      <Kpi
        etiqueta="Visitas"
        valor={String(summary.visits)}
        nota={summary.entries !== summary.visits ? `${summary.entries} citas en total` : undefined}
      />
      <Kpi
        etiqueta="Gastado"
        // El "o más" no es cortesía: hay visitas sin cuenta cerrada, y presentar
        // el total como exacto convertiría un dato incompleto en una decisión.
        valor={summary.totalIsPartial ? `${formatCOP(summary.totalSpent)} o más` : formatCOP(summary.totalSpent)}
        nota={summary.totalIsPartial ? "Hay visitas sin cuenta cerrada" : undefined}
      />
      <Kpi
        etiqueta="Primera visita"
        valor={summary.firstVisit ? formatDateLong(summary.firstVisit, true) : "—"}
      />
      <Kpi
        etiqueta="Última visita"
        valor={summary.lastVisit ? formatDateLong(summary.lastVisit, true) : "—"}
      />
      <Kpi
        etiqueta="No asistió"
        valor={String(summary.noShows)}
        nota={summary.cancellations > 0 ? `${summary.cancellations} canceladas` : undefined}
      />
    </div>
  );
}

function Kpi({
  etiqueta,
  valor,
  nota,
}: {
  etiqueta: string;
  valor: string;
  nota?: string;
}) {
  return (
    <div
      className="ui-card"
      style={{ padding: "0.75rem", display: "grid", gap: "0.125rem", gridTemplateColumns: "minmax(0, 1fr)" }}
    >
      <span
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--color-ink-soft)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {etiqueta}
      </span>
      <span
        className="ui-num"
        style={{ fontSize: "var(--text-md)", color: "var(--color-carbon)", fontWeight: 600 }}
      >
        {valor}
      </span>
      {nota ? <span style={metaStyle}>{nota}</span> : null}
    </div>
  );
}

function historyColumns(): Array<Column<HistoryEntry>> {
  return [
    {
      key: "fecha",
      header: "Fecha",
      from: "siempre",
      listSlot: "primary",
      width: "22%",
      // Corta, no larga: en la lista de dos líneas de 390 px el primario se
      // recorta con puntos suspensivos, y "domingo 20 de septiembr…" pierde
      // justo el año, que es el dato que se está buscando en una historia.
      text: (row) => fechaCorta(row.start),
      render: (row) => <span className="ui-num">{fechaCorta(row.start)}</span>,
    },
    {
      key: "hora",
      header: "Hora",
      from: "lg",
      listSlot: "secondary",
      text: (row) => formatTime(row.start),
      render: (row) => formatTime(row.start),
    },
    {
      key: "servicio",
      header: "Servicio",
      from: "md",
      listSlot: "secondary",
      text: (row) => row.serviceName,
      render: (row) => row.serviceName,
    },
    {
      key: "tecnica",
      header: "Técnica",
      from: "lg",
      listSlot: "secondary",
      text: (row) => row.providerName ?? "",
      render: (row) => row.providerName ?? <span style={{ color: "var(--color-ink-mute)" }}>—</span>,
    },
    {
      key: "origen",
      header: "Origen",
      from: "lg",
      text: (row) => (row.source === "ea" ? "Agenda" : "Histórico"),
      render: (row) => (
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          {row.source === "ea" ? "Agenda" : "Histórico"}
        </span>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      from: "md",
      listSlot: "trailing",
      text: (row) => row.rawStatus ?? "",
      render: (row) =>
        row.rawStatus === null ? (
          // El export de Agenda Pro no traía estado. Pintarlo "Sin reconocer"
          // haría ver un problema donde solo hay un campo que ese sistema no
          // guardaba; `history.ts` igual la cuenta como visita.
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            Sin estado
          </span>
        ) : (
          <StatusPill status={row.rawStatus} size="sm" />
        ),
    },
    {
      key: "cobrado",
      header: "Cobrado",
      from: "siempre",
      numeric: true,
      listSlot: "trailing",
      text: (row) => (row.amountCharged === null ? "" : formatCOP(row.amountCharged)),
      render: (row) =>
        row.amountCharged === null ? (
          // `—` y no `$ 0`: no saber cuánto se cobró y haber cobrado cero son
          // cosas distintas, y la segunda es una cortesía que alguien decidió.
          <span style={{ color: "var(--color-ink-mute)" }}>—</span>
        ) : (
          formatCOP(row.amountCharged)
        ),
    },
  ];
}

/** `"2026-08-14 14:00:00"` → `"14 ago 2026"`. */
function fechaCorta(wallClock: string): string {
  return `${formatDateShort(wallClock)} ${wallClock.slice(0, 4)}`;
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: "0.0625rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <dt style={{ ...metaStyle, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {etiqueta}
      </dt>
      <dd style={{ margin: 0, fontSize: "var(--text-sm)" }}>{children}</dd>
    </div>
  );
}

function Aviso({ tono, children }: { tono: "warn" | "info"; children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: "var(--text-xs)",
        padding: "0.5rem 0.625rem",
        borderRadius: "var(--radius-md)",
        background: `var(--color-${tono}-tint)`,
        border: `1px solid var(--color-${tono}-line)`,
        color: `var(--color-${tono}-ink)`,
      }}
    >
      {children}
    </p>
  );
}

const metaStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};

const dlStyle: React.CSSProperties = {
  margin: 0,
  display: "grid",
  gap: "0.625rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(12rem, 100%), 1fr))",
};
