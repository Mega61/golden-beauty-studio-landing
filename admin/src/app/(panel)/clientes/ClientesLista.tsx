import Link from "next/link";
import Form from "next/form";

import {
  DataTable,
  EmptyState,
  ReadOnlyBand,
  formatPhoneCO,
  type Column,
} from "@/components/ui";

import { clientHref, type ClientListResult } from "./data";
import type { ResolvedClient } from "./identity";

/**
 * La lista de clientas: búsqueda arriba, resultados abajo.
 *
 * **La búsqueda va por la URL, no por estado de React.** `next/form` empuja el
 * término a `?q=` y el Server Component vuelve a consultar: el resultado es
 * compartible, sobrevive a recargar, y funciona con el teclado del celular
 * cerrándose de golpe. Un `useState` acá cambiaría todo eso por nada.
 *
 * Es presentacional a propósito —recibe el resultado ya resuelto— para poder
 * mirarla a 390 / 768 / 1440 sin base de datos ni agenda levantadas.
 */
export function ClientesLista({ result }: { result: ClientListResult }) {
  const columns = clientColumns();

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {result.failure ? (
        <ReadOnlyBand
          reason={result.failure.message}
          detailsHref={result.failure.transient ? undefined : "/diagnostico"}
        />
      ) : null}

      <Form action="/clientes" style={{ display: "flex", gap: "0.5rem" }}>
        <label className="ui-sr" htmlFor="q">
          Buscar clienta por nombre, teléfono o correo
        </label>
        <input
          id="q"
          name="q"
          type="search"
          className="ui-input"
          defaultValue={result.query ?? ""}
          placeholder="Nombre, teléfono o correo"
          autoComplete="off"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="submit" className="ui-btn ui-btn--primary">
          Buscar
        </button>
      </Form>

      {result.query === null && !result.failure ? (
        <p style={meta}>
          Las {result.clients.length} clientas más recientes
          {result.truncated ? ", de una lista más larga. Buscá para encontrar el resto." : "."}
        </p>
      ) : null}

      {result.clients.length > 0 ? (
        <p style={meta}>
          {result.clients.length === 1
            ? "1 clienta"
            : `${result.clients.length} clientas`}
          {countMerged(result.clients) > 0
            ? ` · ${countMerged(result.clients)} con más de una ficha en la agenda`
            : ""}
        </p>
      ) : null}

      <DataTable
        columns={columns}
        rows={result.clients}
        rowKey={(row) => keyOf(row)}
        caption="Clientas"
        empty={emptyFor(result)}
      />
    </div>
  );
}

const meta: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};

function keyOf(client: ResolvedClient): string {
  return client.key.kind === "tel"
    ? `tel:${client.key.phone}`
    : `ea:${client.key.eaCustomerId}`;
}

function countMerged(clients: readonly ResolvedClient[]): number {
  return clients.filter((client) => client.merged).length;
}

function clientColumns(): Array<Column<ResolvedClient>> {
  return [
    {
      key: "nombre",
      header: "Clienta",
      from: "siempre",
      listSlot: "primary",
      width: "34%",
      text: (row) => row.name || "Sin nombre",
      render: (row) => (
        <Link href={clientHref(row.key)} style={{ fontWeight: 600 }}>
          {row.name || "Sin nombre"}
        </Link>
      ),
    },
    {
      key: "telefono",
      header: "Teléfono",
      from: "md",
      listSlot: "secondary",
      text: (row) => (row.phone ? formatPhoneCO(row.phone) : "Sin teléfono"),
      render: (row) =>
        row.phone ? (
          <span className="ui-num">{formatPhoneCO(row.phone)}</span>
        ) : (
          // No es un vacío decorativo: sin teléfono esta clienta no se puede
          // deduplicar ni encontrar cuando vuelva a llamar.
          <span style={{ color: "var(--color-ink-soft)" }}>Sin teléfono</span>
        ),
    },
    {
      key: "correo",
      header: "Correo",
      from: "lg",
      listSlot: "secondary",
      text: (row) => row.email ?? "",
      render: (row) =>
        row.email ? (
          <span>{row.email}</span>
        ) : row.suspiciousEmails.length > 0 ? (
          <span style={{ color: "var(--color-warn-ink)" }} title={row.suspiciousEmails.join(", ")}>
            Correo de relleno
          </span>
        ) : (
          <span style={{ color: "var(--color-ink-mute)" }}>—</span>
        ),
    },
    {
      key: "fichas",
      header: "Fichas en EA",
      from: "lg",
      align: "end",
      listSlot: "trailing",
      text: (row) => String(row.eaCustomerIds.length),
      render: (row) =>
        row.merged ? (
          <span
            style={{
              fontSize: "var(--text-2xs)",
              padding: "0.0625rem 0.375rem",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-warn-tint)",
              border: "1px solid var(--color-warn-line)",
              color: "var(--color-warn-ink)",
              whiteSpace: "nowrap",
            }}
          >
            {row.eaCustomerIds.length} unificadas
          </span>
        ) : // Una sola ficha es el caso normal: pintar un "1" en cada fila
        // gasta la columna donde el ojo busca lo que se sale de lo normal.
        null,
    },
  ];
}

function emptyFor(result: ClientListResult): React.ReactNode {
  if (result.failure) {
    return (
      <EmptyState
        icon="alerta"
        title="No se pudo consultar la agenda"
        body="Las clientas viven en Easy!Appointments y ahora mismo no responde. El histórico y la caja siguen disponibles."
      />
    );
  }
  if (result.query !== null) {
    return (
      <EmptyState
        icon="buscar"
        title={`Ninguna clienta con «${result.query}»`}
        body="Probá con menos letras, con el número sin espacios, o con el apellido. La búsqueda mira nombre, teléfono y correo."
        secondary={
          <Link className="ui-btn ui-btn--ghost" href="/clientes">
            Ver las más recientes
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon="clientas"
      title="Todavía no hay clientas"
      body="Aparecen acá en cuanto se agenda la primera cita, o cuando se importe el histórico de Agenda Pro."
    />
  );
}
