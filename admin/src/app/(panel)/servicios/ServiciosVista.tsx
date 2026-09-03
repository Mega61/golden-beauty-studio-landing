import {
  Card,
  CardHead,
  DataTable,
  EmptyState,
  formatCOP,
  formatDuration,
  type Column,
} from "@/components/ui";

import {
  BotonDesvincular,
  BotonPublicar,
  BotonPublicarTodo,
  FormVincular,
  type OpcionServicio,
} from "./AccionesDiff";
import type { DiffRow, DiffState } from "./diff";
import type { ServicesView } from "./data";

/**
 * Servicios: el catálogo en lectura y el diff contra la vitrina.
 *
 * **El catálogo no se edita acá y eso es la funcionalidad**, no una limitación.
 * `src/data/pricing.ts` es la fuente de verdad de los precios; el panel los
 * publica en un solo sentido. Un formulario de precio en esta pantalla sería el
 * tercer escritor sobre el mismo número, y tres escritores es deriva
 * garantizada.
 *
 * En móvil la pantalla es de solo lectura (§ Navegación y pantallas): los
 * botones viven dentro de `ui-only-md`. Publicar un catálogo entero de pie con
 * una mano no es un gesto que haya que facilitar.
 */
export function ServiciosVista({
  view,
  puedePublicar,
}: {
  view: ServicesView;
  /** `catalogo:publicar` — solo la dueña. Recepción ve el diff sin botones. */
  puedePublicar: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {view.failures.map((failure, index) => (
        <p
          key={index}
          role="status"
          style={{
            margin: 0,
            fontSize: "var(--text-xs)",
            padding: "0.625rem 0.75rem",
            borderRadius: "var(--radius-md)",
            background: "var(--color-error-tint)",
            border: "1px solid var(--color-error-line)",
            color: "var(--color-error-ink)",
          }}
        >
          <strong>{failure.message}</strong>
          {failure.detail ? <> {failure.detail}</> : null}
        </p>
      ))}

      {view.diff ? (
        <Diff view={view} diff={view.diff} puedePublicar={puedePublicar} />
      ) : (
        <Card>
          <EmptyState
            icon="alerta"
            title="El diff no se puede calcular"
            body="Hace falta poder leer las tres fuentes: la vitrina, el catálogo de la agenda y la correspondencia entre las dos. Con una sola que falte, el resultado diría que sobra todo lo que no se pudo leer."
          />
        </Card>
      )}

      <Catalogo view={view} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// El diff
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<DiffState, string> = {
  "al-dia": "Al día",
  desincronizado: "Difiere",
  "sin-vincular": "Sin vincular",
  "mapa-roto": "Mapa roto",
  "solo-en-ea": "Solo en la agenda",
};

/** El mismo estado, en plural, para el conteo del encabezado. */
const STATE_COUNT_LABEL: Record<DiffState, string> = {
  "al-dia": "al día",
  desincronizado: "desincronizados",
  "sin-vincular": "sin vincular",
  "mapa-roto": "con el mapa roto",
  "solo-en-ea": "solo en la agenda",
};

const STATE_TONE: Record<DiffState, "ok" | "warn" | "error" | "info"> = {
  "al-dia": "ok",
  desincronizado: "warn",
  "sin-vincular": "info",
  "mapa-roto": "error",
  "solo-en-ea": "info",
};

function Diff({
  view,
  diff,
  puedePublicar,
}: {
  view: ServicesView;
  diff: NonNullable<ServicesView["diff"]>;
  puedePublicar: boolean;
}) {
  const libres: OpcionServicio[] = view.services
    .filter((service) => !view.serviceMap.some((row) => row.ea_service_id === service.id))
    .map((service) => ({
      id: service.id,
      label: `${service.name ?? "Sin nombre"} · #${service.id}`,
    }));

  const pendientes = diff.rows.filter((row) => row.state !== "al-dia");

  return (
    <Card padded={false}>
      <CardHead
        title="Vitrina contra agenda"
        actions={
          puedePublicar && diff.counts.desincronizado > 0 ? (
            <span className="ui-only-md">
              <BotonPublicarTodo cantidad={diff.counts.desincronizado} />
            </span>
          ) : null
        }
      />

      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <p style={meta}>
          {(Object.keys(STATE_LABEL) as DiffState[])
            .filter((state) => diff.counts[state] > 0)
            .map((state) => `${diff.counts[state]} ${STATE_COUNT_LABEL[state]}`)
            .join(" · ")}
          {view.pricingSourcePath ? ` · vitrina leída de ${view.pricingSourcePath}` : ""}
        </p>

        {pendientes.length === 0 ? (
          <EmptyState
            icon="check"
            title="La agenda cobra lo que dice la vitrina"
            body="Todos los servicios de la vitrina están vinculados y con el mismo precio y duración que en la agenda."
          />
        ) : (
          <DataTable
            columns={diffColumns(puedePublicar, libres)}
            rows={pendientes}
            rowKey={(row) => row.key}
            caption="Diferencias entre la vitrina y la agenda"
          />
        )}
      </div>
    </Card>
  );
}

function diffColumns(
  puedePublicar: boolean,
  libres: readonly OpcionServicio[],
): Array<Column<DiffRow>> {
  const columns: Array<Column<DiffRow>> = [
    {
      key: "id",
      header: "Servicio",
      from: "siempre",
      listSlot: "primary",
      width: "26%",
      text: (row) => row.pricingId ?? row.eaName ?? `#${row.eaServiceId}`,
      render: (row) => (
        <span>
          <span style={{ fontWeight: 600 }}>
            {row.pricingId ?? row.eaName ?? `#${row.eaServiceId}`}
          </span>
          {row.categoryId ? (
            <span style={{ color: "var(--color-ink-soft)" }}> · {row.categoryId}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      from: "md",
      listSlot: "trailing",
      // Un ítem marcado "solo vitrina" no está sin vincular por descuido: no
      // se agenda, y por eso no tiene servicio en EA. Decirlo acá lo saca de la
      // lista de pendientes sin esconderlo.
      text: (row) => etiquetaEstado(row),
      render: (row) => (
        <Etiqueta tono={row.showcaseOnly ? "info" : STATE_TONE[row.state]}>
          {etiquetaEstado(row)}
        </Etiqueta>
      ),
    },
    {
      key: "precio",
      header: "Precio",
      from: "siempre",
      numeric: true,
      listSlot: "secondary",
      text: (row) => comparacion(row.eaPrice, row.showcasePrice, formatCOP),
      render: (row) => (
        <Comparacion
          vitrina={row.showcasePrice}
          agenda={row.eaPrice}
          difiere={row.differing.includes("precio")}
          formato={formatCOP}
        />
      ),
    },
    {
      key: "duracion",
      header: "Duración",
      from: "lg",
      numeric: true,
      listSlot: "secondary",
      text: (row) => comparacion(row.eaDuration, row.showcaseDuration, formatDuration),
      render: (row) => (
        <Comparacion
          vitrina={row.showcaseDuration}
          agenda={row.eaDuration}
          difiere={row.differing.includes("duracion")}
          formato={formatDuration}
        />
      ),
    },
    {
      key: "ea",
      header: "En la agenda",
      from: "lg",
      text: (row) => (row.eaServiceId === null ? "" : `#${row.eaServiceId}`),
      render: (row) =>
        row.eaServiceId === null ? (
          <span style={{ color: "var(--color-ink-mute)" }}>—</span>
        ) : (
          <span className="ui-num">
            #{row.eaServiceId}
            {row.eaName ? <span style={{ color: "var(--color-ink-soft)" }}> {row.eaName}</span> : null}
          </span>
        ),
    },
  ];

  if (puedePublicar) {
    columns.push({
      key: "accion",
      header: "Acción",
      from: "md",
      width: "18rem",
      text: () => "",
      render: (row) => <span className="ui-only-md">{accionPara(row, libres)}</span>,
    });
  }

  return columns;
}

function etiquetaEstado(row: DiffRow): string {
  return row.showcaseOnly && row.state === "sin-vincular"
    ? "Solo vitrina"
    : STATE_LABEL[row.state];
}

function accionPara(row: DiffRow, libres: readonly OpcionServicio[]): React.ReactNode {
  if (row.state === "desincronizado" && row.pricingId) {
    return <BotonPublicar pricingId={row.pricingId} />;
  }
  if (row.state === "sin-vincular" && row.pricingId) {
    return <FormVincular pricingId={row.pricingId} opciones={libres} />;
  }
  if (row.state === "mapa-roto" && row.pricingId) {
    return <BotonDesvincular pricingId={row.pricingId} />;
  }
  if (row.state === "solo-en-ea") {
    return (
      <span style={meta}>
        Puede ser un servicio interno. Si debería estar en la vitrina, hay que
        agregar su id a <code>pricing.ts</code>.
      </span>
    );
  }
  return null;
}

/**
 * `agenda → vitrina`: **de lo que se cobra hoy a lo que va a quedar.**
 *
 * El orden no es cosmético. Al revés se lee como "de 120.000 baja a 118.000",
 * que es exactamente lo contrario de lo que hace publicar, y alguien podría
 * apretar el botón creyendo que baja un precio cuando lo sube.
 *
 * Cuando falta uno de los dos no se dibuja la flecha: `— → $ 120.000` no es
 * información, es ruido con forma de cambio.
 */
function comparacion(
  agenda: number | null,
  vitrina: number | null,
  formato: (value: number) => string,
): string {
  if (agenda === null) return vitrina === null ? "—" : formato(vitrina);
  if (vitrina === null) return formato(agenda);
  return agenda === vitrina
    ? formato(agenda)
    : `${formato(agenda)} → ${formato(vitrina)}`;
}

function Comparacion({
  vitrina,
  agenda,
  difiere,
  formato,
}: {
  vitrina: number | null;
  agenda: number | null;
  difiere: boolean;
  formato: (value: number) => string;
}) {
  if (!difiere) {
    return (
      <span className="ui-num">
        {vitrina !== null ? formato(vitrina) : agenda !== null ? formato(agenda) : "—"}
      </span>
    );
  }
  return (
    <span className="ui-num" style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--color-ink-soft)", textDecoration: "line-through" }}>
        {agenda === null ? "sin precio" : formato(agenda)}
      </span>{" "}
      <span style={{ color: "var(--color-warn-ink)", fontWeight: 600 }}>
        {vitrina === null ? "—" : formato(vitrina)}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// El catálogo en lectura
// ---------------------------------------------------------------------------

function Catalogo({ view }: { view: ServicesView }) {
  const porEa = new Map(view.serviceMap.map((row) => [row.ea_service_id, row.pricing_id]));

  const columns: Array<Column<(typeof view.services)[number]>> = [
    {
      key: "nombre",
      header: "Servicio",
      from: "siempre",
      listSlot: "primary",
      width: "32%",
      text: (row) => row.name ?? "Sin nombre",
      render: (row) => <span style={{ fontWeight: 600 }}>{row.name ?? "Sin nombre"}</span>,
    },
    {
      key: "categoria",
      header: "Categoría",
      from: "lg",
      listSlot: "secondary",
      text: (row) =>
        row.serviceCategoryId === null
          ? "Sin categoría"
          : (view.categoryName.get(row.serviceCategoryId) ?? "Sin categoría"),
      render: (row) =>
        row.serviceCategoryId === null
          ? "—"
          : (view.categoryName.get(row.serviceCategoryId) ?? "—"),
    },
    {
      key: "precio",
      header: "Precio",
      from: "siempre",
      numeric: true,
      listSlot: "trailing",
      text: (row) => (row.price === null ? "" : formatCOP(row.price)),
      render: (row) =>
        row.price === null ? (
          // Un servicio sin precio congela `null` al agendar, y esa cita
          // después no se puede liquidar. No es un guion decorativo.
          <span style={{ color: "var(--color-error-ink)" }}>Sin precio</span>
        ) : (
          formatCOP(row.price)
        ),
    },
    {
      key: "duracion",
      header: "Duración",
      from: "md",
      numeric: true,
      listSlot: "secondary",
      text: (row) => (row.duration === null ? "" : formatDuration(row.duration)),
      render: (row) => (row.duration === null ? "—" : formatDuration(row.duration)),
    },
    {
      key: "vitrina",
      header: "Id en la vitrina",
      from: "lg",
      text: (row) => porEa.get(row.id) ?? "",
      render: (row) => {
        const pricingId = porEa.get(row.id);
        return pricingId ? (
          <code style={{ fontSize: "var(--text-2xs)" }}>{pricingId}</code>
        ) : (
          <span style={{ color: "var(--color-ink-mute)" }}>—</span>
        );
      },
    },
    {
      key: "capacidad",
      header: "A la vez",
      from: "lg",
      numeric: true,
      text: (row) => String(row.attendantsNumber ?? 1),
      render: (row) => row.attendantsNumber ?? 1,
    },
  ];

  return (
    <Card padded={false}>
      <CardHead title="Catálogo de la agenda" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.5rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <p style={meta}>
          En lectura. Los precios se publican desde la vitrina; el nombre, el
          color y la categoría se editan en la agenda.
        </p>
        <DataTable
          columns={columns}
          rows={view.services}
          rowKey={(row) => String(row.id)}
          caption="Servicios de Easy!Appointments"
          empty={
            <EmptyState
              icon="servicios"
              title="La agenda no tiene servicios"
              body="Hay que crearlos en Easy!Appointments una vez y vincularlos acá con los ids de la vitrina."
            />
          }
        />
      </div>
    </Card>
  );
}

function Etiqueta({
  tono,
  children,
}: {
  tono: "ok" | "warn" | "error" | "info";
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        fontSize: "var(--text-2xs)",
        padding: "0.0625rem 0.375rem",
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        background: `var(--color-${tono}-tint)`,
        border: `1px solid var(--color-${tono}-line)`,
        color: `var(--color-${tono}-ink)`,
      }}
    >
      {children}
    </span>
  );
}

const meta: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-2xs)",
  color: "var(--color-ink-soft)",
};
