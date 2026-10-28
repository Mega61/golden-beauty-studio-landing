import Link from "next/link";

import {
  DataTable,
  EmptyState,
  Icon,
  ReadOnlyBand,
  formatPhoneCO,
  type Column,
} from "@/components/ui";
import { WhatsAppLink } from "@/components/ui/WhatsAppLink";

import { NuevaClienta } from "./AccionesClienta";
import { BuscadorClientas } from "./BuscadorClientas";
import styles from "./clientes.module.css";
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
export function ClientesLista({
  result,
  canExport = false,
}: {
  result: ClientListResult;
  /** `clientes:exportar`: el enlace a la lista para Meta. Solo la dueña. */
  canExport?: boolean;
}) {
  const columns = clientColumns();

  const from = (result.page - 1) * result.pageLength + 1;
  const to = from + result.clients.length - 1;
  const pageHref = (n: number) => {
    const q = new URLSearchParams();
    if (result.query) q.set("q", result.query);
    if (n > 1) q.set("pagina", String(n));
    const qs = q.toString();
    return qs ? `/clientes?${qs}` : "/clientes";
  };

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div className={styles.toolbar}>
        <BuscadorClientas key={result.query ?? ""} initial={result.query ?? ""} />
        {!result.failure ? (
          <p className={styles.meta} aria-live="polite">
            {result.query !== null
              ? result.total === 1
                ? "1 cliente"
                : `${result.total ?? result.clients.length} clientes con «${result.query}»`
              : "Lo más reciente primero"}
            {countMerged(result.clients) > 0
              ? ` · ${countMerged(result.clients)} con más de una ficha en la agenda`
              : ""}
          </p>
        ) : null}
      </div>

      {result.failure ? (
        <ReadOnlyBand
          reason={result.failure.message}
          detailsHref={result.failure.transient ? undefined : "/diagnostico"}
        />
      ) : null}

      {/*
        El alta va **debajo del buscador** y plegada: casi siempre la clienta ya
        existe, y el primer gesto correcto es buscarla. Un formulario de alta
        arriba y desplegado invita a crear la duplicada que después hay que
        fusionar.
      */}
      <div className={styles.actions}>
        <NuevaClienta />
        {canExport ? (
          <Link className="ui-btn ui-btn--secondary ui-btn--sm" href="/clientes/exportar-meta">
            Exportar para Meta
          </Link>
        ) : null}
      </div>

      <div className={styles.table}>
        <DataTable
          columns={columns}
          rows={result.clients}
          rowKey={(row) => keyOf(row)}
          caption="Clientes"
          empty={emptyFor(result)}
          listChevron
        />
      </div>

      {result.clients.length > 0 && (result.page > 1 || result.hasNext) ? (
        <nav className={styles.pager} aria-label="Páginas de clientes">
          {result.page > 1 ? (
            <Link className="ui-btn ui-btn--secondary ui-btn--sm" href={pageHref(result.page - 1)}>
              <Icon name="chevron-izq" size={16} />
              Anteriores
            </Link>
          ) : (
            <span />
          )}
          <span className={styles.pagerRange}>
            {from}–{to}
            {result.total !== null ? ` de ${result.total}` : ""}
          </span>
          {result.hasNext ? (
            <Link className="ui-btn ui-btn--secondary ui-btn--sm" href={pageHref(result.page + 1)}>
              Siguientes
              <Icon name="chevron-der" size={16} />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

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
      header: "Cliente",
      from: "siempre",
      listSlot: "primary",
      width: "34%",
      text: (row) => row.name || "Sin nombre",
      render: (row) => (
        <Link className="ui-list__link" href={clientHref(row.key)} style={{ fontWeight: 600 }}>
          {row.name || "Sin nombre"}
        </Link>
      ),
    },
    {
      // En el celular el número va en la segunda línea, como texto, y el
      // botón de WhatsApp queda en su ícono a la derecha (`wa`): con el número
      // adentro, el botón se comía media fila y el nombre —que es lo que se
      // busca— quedaba apretado contra el borde.
      key: "telefono-lista",
      header: "Teléfono",
      from: "lista",
      listSlot: "secondary",
      text: (row) => (row.phone ? formatPhoneCO(row.phone) : "Sin teléfono"),
      render: (row) => (row.phone ? formatPhoneCO(row.phone) : "Sin teléfono"),
    },
    {
      key: "wa",
      header: "WhatsApp",
      from: "lista",
      listSlot: "trailing",
      render: (row) =>
        row.phone ? (
          <WhatsAppLink phone={row.phone} customerName={row.name} showNumber={false} />
        ) : null,
    },
    {
      key: "telefono",
      header: "Teléfono",
      from: "md",
      // En la tabla, el teléfono es el botón para escribirle por WhatsApp.
      listSlot: "oculto",
      text: (row) => (row.phone ? formatPhoneCO(row.phone) : "Sin teléfono"),
      render: (row) =>
        row.phone ? (
          <WhatsAppLink phone={row.phone} customerName={row.name} />
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
        body="Los datos de clientes viven en Easy!Appointments y ahora mismo no responde. El histórico y la caja siguen disponibles."
      />
    );
  }
  if (result.query !== null) {
    return (
      <EmptyState
        icon="buscar"
        title={`Nadie con «${result.query}»`}
        body="Prueba con menos letras, con el número sin espacios, o con el apellido. La búsqueda mira nombre, teléfono y correo."
        secondary={
          <Link className="ui-btn ui-btn--ghost" href="/clientes">
            Ver lo más reciente
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      icon="clientas"
      title="Todavía no hay clientes"
      body="Aparecen acá en cuanto se agenda la primera cita, o cuando se importe el histórico de Agenda Pro."
    />
  );
}
