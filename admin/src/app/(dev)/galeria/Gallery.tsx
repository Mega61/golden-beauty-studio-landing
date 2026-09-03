"use client";

import { useState } from "react";
import {
  Button,
  ButtonLink,
  Card,
  CardHead,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  FormErrorSummary,
  Icon,
  LoadingRegion,
  MoneyInput,
  Panel,
  PanelInline,
  ReadOnlyBand,
  Select,
  Skeleton,
  SkeletonStat,
  SkeletonText,
  StatusPill,
  STATUS_HEX,
  STATUS_IDS,
  STATUS_META,
  TextArea,
  TextInput,
  contrastRatio,
  formatCOP,
  formatDateLong,
  formatTimeRange,
  useToast,
  type Column,
} from "@/components/ui";
import { CITAS, type CitaDemo } from "./fixtures";

/**
 * La galería de componentes.
 *
 * Es la superficie con la que un humano valida este paquete: cada componente
 * con sus siete estados, la paleta con sus contrastes **calculados en vivo**
 * (no transcritos a mano — un número copiado envejece mal), y los tres estados
 * de sistema.
 *
 * Se revisa a 390 / 768 / 1440 px. A cada uno de esos anchos hay algo distinto
 * que mirar: en 390, que la tabla se haya vuelto lista y que la barra inferior
 * no tape la última fila; en 768, que el riel muestre solo iconos y la tabla
 * haya soltado columnas; en 1440, que la barra lateral tenga etiquetas y el
 * panel se abra al costado en vez de subir desde abajo.
 */

const COLUMNAS: Column<CitaDemo>[] = [
  {
    key: "clienta",
    header: "Clienta",
    from: "siempre",
    listSlot: "primary",
    render: (r) => r.clienta,
    text: (r) => r.clienta,
  },
  {
    key: "hora",
    header: "Hora",
    from: "siempre",
    listSlot: "secondary",
    width: "10rem",
    render: (r) => formatTimeRange(r.hora, r.fin),
    text: (r) => formatTimeRange(r.hora, r.fin),
  },
  {
    key: "tecnica",
    header: "Profesional",
    from: "md",
    listSlot: "secondary",
    width: "8rem",
    render: (r) => r.tecnica,
    text: (r) => r.tecnica,
  },
  {
    key: "servicio",
    header: "Servicio",
    from: "lg",
    listSlot: "secondary",
    render: (r) => r.servicio,
    text: (r) => r.servicio,
  },
  {
    key: "total",
    header: "Total",
    from: "md",
    numeric: true,
    width: "8rem",
    listSlot: "trailing",
    render: (r) => formatCOP(r.totalCOP),
    text: (r) => formatCOP(r.totalCOP),
  },
  {
    key: "estado",
    header: "Estado",
    from: "md",
    width: "9rem",
    listSlot: "trailing",
    render: (r) => <StatusPill status={r.estado} />,
    text: (r) => r.estado,
  },
];

export function Gallery() {
  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <Intro />
      <Tipografia />
      <Paleta />
      <Estados />
      <Botones />
      <Campos />
      <Tabla />
      <Capas />
      <Carga />
      <Vacios />
      <Sistema />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Seccion({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <Card as="section" id={id} padded={false}>
      <CardHead title={title} />
      <div style={{ padding: "1rem", display: "grid", gap: "0.875rem" }}>
        {note ? (
          <p style={{ color: "var(--color-ink-soft)", maxWidth: "62ch" }}>{note}</p>
        ) : null}
        {children}
      </div>
    </Card>
  );
}

function Fila({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.625rem",
        alignItems: "center",
      }}
    >
      {children}
    </div>
  );
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--text-2xs)",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--color-ink-soft)",
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------

function Intro() {
  return (
    <Card>
      <p style={{ maxWidth: "62ch", color: "var(--color-ink-soft)" }}>
        Kit de interfaz del panel (WP-A3). Todo lo que consumen las olas C y D:
        tokens, shell, tabla, panel, pastillas de estado, campos, avisos,
        esqueletos y vacíos. Revisar a <strong>390</strong>, <strong>768</strong>{" "}
        y <strong>1440</strong> px — cada ancho cambia algo estructural.
      </p>
      <div style={{ height: "0.75rem" }} />
      <Fila>
        {[
          ["tipografia", "Tipografía"],
          ["paleta", "Paleta"],
          ["estados", "Estados"],
          ["botones", "Botones"],
          ["campos", "Campos"],
          ["tabla", "Tabla"],
          ["capas", "Capas"],
          ["carga", "Carga"],
          ["vacios", "Vacíos"],
          ["sistema", "Sistema"],
        ].map(([id, label]) => (
          <ButtonLink key={id} href={`#${id}`} size="sm" variant="ghost">
            {label}
          </ButtonLink>
        ))}
      </Fila>
    </Card>
  );
}

function Tipografia() {
  const pasos: Array<[string, string, string]> = [
    ["2xs", "12 px", "Meta, encabezados de tabla, pastillas"],
    ["xs", "13 px", "Densidad compacta, celdas, ayudas"],
    ["sm", "14 px", "Cuerpo — el tamaño por defecto"],
    ["md", "16 px", "Entrada de formulario (por debajo, iOS hace zoom)"],
    ["lg", "20 px", "Título de pantalla"],
    ["xl", "24 px", "Cifra de KPI"],
  ];
  return (
    <Seccion
      id="tipografia"
      title="Tipografía"
      note="Escala fija en rem, razón ≈1.15, sin clamp(). Inter para todo; Cormorant vive en exactamente dos lugares y ninguno de los dos es un dato."
    >
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {pasos.map(([k, px, uso]) => (
          <div
            key={k}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "0.875rem",
              flexWrap: "wrap",
              borderBottom: "1px solid var(--hair)",
              paddingBottom: "0.5rem",
            }}
          >
            <code
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--color-ink-soft)",
                minWidth: "4.5rem",
              }}
            >
              text-{k}
            </code>
            <span style={{ fontSize: `var(--text-${k})` }}>
              Acrílicas esculpidas · $ 180.000 · 2:30 p. m.
            </span>
            <span
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--color-ink-soft)",
              }}
            >
              {px} — {uso}
            </span>
          </div>
        ))}
      </div>

      <div>
        <Rotulo>Cifras alineadas</Rotulo>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            marginTop: "0.25rem",
          }}
        >
          `tabular-nums` en toda cifra: las columnas de pesos tienen que poder
          compararse fila contra fila sin que los dígitos bailen.
        </p>
        <div
          style={{
            marginTop: "0.5rem",
            display: "grid",
            gap: "0.125rem",
            width: "fit-content",
          }}
        >
          {[180000, 1350000, 95000, 210000].map((n) => (
            <div key={n} style={{ textAlign: "right", fontWeight: 600 }}>
              {formatCOP(n)}
            </div>
          ))}
        </div>
      </div>

      <div>
        <Rotulo>Los dos únicos lugares con Cormorant</Rotulo>
        <div
          style={{
            marginTop: "0.5rem",
            display: "flex",
            gap: "1.5rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span className="ui-wordmark" style={{ fontSize: "1.125rem" }}>
            Golden Beauty
          </span>
          <span className="ui-wordmark" style={{ fontSize: "1.75rem" }}>
            Golden Beauty Studio
          </span>
          <span
            style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}
          >
            wordmark de la barra lateral · pantalla de login
          </span>
        </div>
      </div>
    </Seccion>
  );
}

function Muestra({
  hex,
  name,
  on,
}: {
  hex: string;
  name: string;
  on?: string;
}) {
  return (
    <div style={{ minWidth: "10rem" }}>
      <div
        style={{
          height: "2.75rem",
          background: hex,
          border: "1px solid var(--hair)",
          borderRadius: "var(--radius-sm)",
        }}
      />
      <div
        style={{
          marginTop: "0.3125rem",
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--color-ink-soft)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {hex}
        {on ? ` · ${contrastRatio(hex, on).toFixed(2)}:1` : ""}
      </div>
    </div>
  );
}

function Paleta() {
  const PAPER = "#fbf8f3";
  const CREAM = "#f3ecdf";
  return (
    <Seccion
      id="paleta"
      title="Superficies, tinta y dorado"
      note="Los paneles se separan del contenido por superficie, no por sombra. El dorado es acción primaria, selección y foco — nunca codifica un dato."
    >
      <div>
        <Rotulo>Superficies</Rotulo>
        <Fila>
          <Muestra hex="#fbf8f3" name="paper — contenido" />
          <Muestra hex="#f8f4ee" name="ivory — fondo de la app" />
          <Muestra hex="#f3ecdf" name="cream — barra lateral, toolbar" />
          <Muestra hex="#efe7da" name="ivory-deep — tercera capa" />
        </Fila>
      </div>

      <div>
        <Rotulo>Tinta (ratio contra marfil)</Rotulo>
        <Fila>
          <Muestra hex="#1c1714" name="carbon — titulares" on={PAPER} />
          <Muestra hex="#2a221c" name="ink — cuerpo" on={PAPER} />
          <Muestra hex="#5b4a3a" name="ink-soft — labels, placeholder" on={PAPER} />
          <Muestra hex="#8a7a68" name="ink-mute — NO para texto" on={PAPER} />
        </Fila>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            marginTop: "0.375rem",
            maxWidth: "62ch",
          }}
        >
          <code>ink-mute</code> mide 3.91:1 sobre marfil y 3.53:1 sobre crema: no
          llega al piso de 4.5:1. Vive para iconos decorativos, filetes y el
          estado deshabilitado.
        </p>
      </div>

      <div>
        <Rotulo>Dorado (ratio contra crema, la superficie más oscura)</Rotulo>
        <Fila>
          <Muestra hex="#ac8231" name="gold — filete de marca" on={CREAM} />
          <Muestra hex="#8b6a1f" name="gold-dark — relleno y foco" on={CREAM} />
          <Muestra hex="#6d5214" name="gold-press — :active" on={CREAM} />
          <Muestra hex="#fff1d6" name="gold-pale — fila seleccionada" on={CREAM} />
        </Fila>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            marginTop: "0.375rem",
            maxWidth: "62ch",
          }}
        >
          El <code>gold</code> de marca se queda en 2.98:1 sobre crema y en 3.50:1
          con texto blanco encima. Por eso el anillo de foco y el relleno
          primario usan <code>gold-dark</code> — mismo gesto, número que sí pasa.
        </p>
      </div>

      <div>
        <Rotulo>Foco</Rotulo>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            margin: "0.25rem 0 0.5rem",
          }}
        >
          Tabula por esta fila: el anillo tiene que verse igual de claro sobre las
          dos superficies.
        </p>
        <div style={{ display: "flex", gap: "1px" }}>
          <div style={{ background: "var(--color-ivory)", padding: "1rem", flex: 1 }}>
            <Button>Sobre marfil</Button>
          </div>
          <div style={{ background: "var(--color-cream)", padding: "1rem", flex: 1 }}>
            <Button>Sobre crema</Button>
          </div>
        </div>
      </div>
    </Seccion>
  );
}

function Estados() {
  const PAPER = "#fbf8f3";
  return (
    <Seccion
      id="estados"
      title="Paleta de estados de la cita"
      note="Superficie tintada + filete de 1 px + punto + texto. Nunca color solo, nunca franja lateral de 4 px. Los ratios de abajo se calculan en vivo desde los mismos hex que usa el CSS."
    >
      <Fila>
        {[...STATUS_IDS, "desconocido" as const].map((id) => (
          <StatusPill key={id} status={id} />
        ))}
      </Fila>

      <div style={{ overflowX: "auto" }}>
        <table className="ui-table" style={{ minWidth: "34rem" }}>
          <thead>
            <tr>
              <th scope="col">Estado</th>
              <th scope="col">Qué significa</th>
              <th scope="col" data-align="end">
                Etiqueta / tinte
              </th>
              <th scope="col" data-align="end">
                Punto / marfil
              </th>
            </tr>
          </thead>
          <tbody>
            {([...STATUS_IDS, "desconocido"] as const).map((id) => {
              const hex = STATUS_HEX[id];
              return (
                <tr key={id}>
                  <td>
                    <StatusPill status={id} />
                  </td>
                  <td style={{ color: "var(--color-ink-soft)" }}>
                    {STATUS_META[id].description}
                  </td>
                  <td data-align="end" data-numeric="true">
                    {contrastRatio(hex.ink, hex.tint).toFixed(2)}:1
                  </td>
                  <td data-align="end" data-numeric="true">
                    {contrastRatio(hex.dot, PAPER).toFixed(2)}:1
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--color-ink-soft)",
          maxWidth: "68ch",
        }}
      >
        Separación medida de los cinco puntos, todos contra todos: peor par ΔE
        16.5 con visión normal (piso 15) y ΔE 9.3 bajo deuteranopía y
        protanopía simuladas (objetivo 8). Los tintes, por ser lavados muy
        claros, no se separan solos — por eso la pastilla siempre lleva punto y
        palabra, y por eso impresa en blanco y negro sigue diciendo el estado.
      </p>

      <div>
        <Rotulo>Impresa (así sale la hoja de ruta del día)</Rotulo>
        <Fila>
          {([...STATUS_IDS] as const).map((id) => (
            <span
              key={id}
              className={`ui-pill ui-pill--${id}`}
              style={{
                background: "transparent",
                color: "#000",
                borderColor: "#000",
              }}
            >
              <span
                className="ui-pill__dot"
                style={{ background: "#000" }}
                aria-hidden
              />
              {STATUS_META[id].label}
            </span>
          ))}
        </Fila>
      </div>
    </Seccion>
  );
}

function Botones() {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  return (
    <Seccion
      id="botones"
      title="Botones — los siete estados"
      note="default · hover · focus · active · disabled · loading · error. El botón que carga no encoge: el contenido se vuelve invisible pero sigue ocupando su ancho, así la fila no salta al enviar."
    >
      {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
        <div key={v}>
          <Rotulo>{v}</Rotulo>
          <Fila>
            <Button variant={v}>Guardar</Button>
            <Button variant={v} icon="mas-signo">
              Nueva cita
            </Button>
            <Button variant={v} disabled>
              Deshabilitado
            </Button>
            <Button variant={v} loading>
              Guardando
            </Button>
            <Button variant={v} size="sm">
              Compacto
            </Button>
            <Button variant={v} icon="buscar" aria-label="Buscar" />
          </Fila>
        </div>
      ))}

      <div>
        <Rotulo>En vivo</Rotulo>
        <Fila>
          <Button
            variant="primary"
            loading={loading}
            onClick={() => {
              setLoading(true);
              setTimeout(() => {
                setLoading(false);
                toast({ message: "Cita guardada.", tone: "ok" });
              }, 1400);
            }}
          >
            Guardar la cita
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              toast({
                message: "Bloqueo eliminado.",
                undo: {
                  onUndo: () => {
                      toast({ message: "Bloqueo restaurado.", tone: "ok" });
                    },
                },
              })
            }
          >
            Eliminar con Deshacer
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                message: "No se pudo guardar: Easy!Appointments no responde.",
                tone: "error",
              })
            }
          >
            Provocar un error
          </Button>
        </Fila>
      </div>

      <div>
        <Rotulo>Área táctil</Rotulo>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            marginTop: "0.25rem",
          }}
        >
          44 px de alto mínimo en densidad táctil (la de por defecto), 34 en
          compacta. La recepción trabaja de pie y con una mano.
        </p>
      </div>
    </Seccion>
  );
}

function Campos() {
  const [total, setTotal] = useState<number | null>(180000);
  const [conError, setConError] = useState(false);

  return (
    <Seccion
      id="campos"
      title="Campos"
      note="Etiqueta real en cada campo, ayuda y error cableados con aria-describedby, y resumen de errores para los formularios largos. El placeholder nunca lleva el nombre del campo."
    >
      {conError ? (
        <FormErrorSummary
          errors={[
            { id: "demo-nombre", message: "Falta el nombre de la clienta." },
            {
              id: "demo-tel",
              message: "El teléfono tiene que empezar por +57 y tener 10 dígitos.",
            },
          ]}
        />
      ) : null}

      <div
        style={{
          display: "grid",
          gap: "0.875rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
        }}
      >
        <Field label="Nombre de la clienta" required>
          {(ids) => <TextInput {...ids} placeholder="Marcela Ríos" />}
        </Field>

        <Field
          label="Teléfono"
          required
          hint="Con indicativo. Es la identidad de la clienta en todo el sistema."
        >
          {(ids) => (
            <TextInput {...ids} inputMode="tel" placeholder="+57 300 123 4567" />
          )}
        </Field>

        <Field
          label="Correo"
          error={conError ? "Ese correo ya está en otra ficha." : undefined}
        >
          {(ids) => <TextInput {...ids} type="email" defaultValue="marce@ejemplo.co" />}
        </Field>

        <Field label="Profesional">
          {(ids) => (
            <Select {...ids} defaultValue="lina">
              <option value="lina">Lina</option>
              <option value="daniela">Daniela</option>
              <option value="sara">Sara</option>
            </Select>
          )}
        </Field>

        <Field label="Campo deshabilitado" hint="Solo lectura mientras EA no responda.">
          {(ids) => <TextInput {...ids} disabled defaultValue="No se puede editar" />}
        </Field>

        <Field label="Campo cargando">
          {(ids) => <TextInput {...ids} loading defaultValue="Buscando…" />}
        </Field>

        <MoneyInput
          label="Total cobrado"
          value={total}
          onValueChange={setTotal}
          hint="Pesos, sin centavos. Se puede pegar «$ 180.000» tal cual."
          required
        />

        <MoneyInput
          label="Total con error"
          value={0}
          onValueChange={() => {}}
          error="Un total de $ 0 necesita un motivo."
        />
      </div>

      <Field label="Observaciones" hint="No viajan a las notas de la cita en EA.">
        {(ids) => (
          <TextArea
            {...ids}
            placeholder="Lo que la próxima persona necesita saber."
          />
        )}
      </Field>

      <Checkbox
        label="Cobrar en efectivo"
        hint="Cambia el reparto por método en el cierre del día."
        defaultChecked
      />
      <Checkbox label="Casilla deshabilitada" disabled />

      <Fila>
        <Button onClick={() => setConError((v) => !v)}>
          {conError ? "Quitar los errores" : "Mostrar el estado de error"}
        </Button>
      </Fila>
    </Seccion>
  );
}

function Tabla() {
  const [sel, setSel] = useState<string | null>("3");
  const [vacia, setVacia] = useState(false);
  const [cargando, setCargando] = useState(false);

  return (
    <Seccion
      id="tabla"
      title="Tabla que colapsa a lista"
      note="Tabla desde 768 px, con columnas prioritarias; tabla completa desde 1024. Por debajo, lista de dos líneas — nunca scroll lateral. Achica la ventana y mira la misma tabla cambiar de forma."
    >
      <Fila>
        <Button size="sm" onClick={() => setCargando((v) => !v)}>
          {cargando ? "Mostrar los datos" : "Ver el esqueleto"}
        </Button>
        <Button size="sm" onClick={() => setVacia((v) => !v)}>
          {vacia ? "Volver a llenarla" : "Ver el vacío"}
        </Button>
      </Fila>

      <div className="ui-card" style={{ overflow: "hidden" }}>
        <DataTable
          columns={COLUMNAS}
          rows={vacia ? [] : CITAS}
          rowKey={(r) => r.id}
          caption={`Citas del ${formatDateLong("2026-08-31 09:00:00")}`}
          loading={cargando}
          selectedKey={sel}
          onRowClick={(r) => setSel(r.id)}
          rowAction="Abrir la cita de"
          empty={
            <EmptyState
              icon="agenda"
              title="Todavía no hay citas hoy"
              body="Cuando la recepción agende la primera, aparece acá con su hora, la profesional y el estado."
              action={
                <Button variant="primary" icon="mas-signo">
                  Nueva cita
                </Button>
              }
            />
          }
        />
      </div>
    </Seccion>
  );
}

function Capas() {
  const [abierto, setAbierto] = useState(false);
  const [sucio, setSucio] = useState(false);
  const { toast } = useToast();

  return (
    <Seccion
      id="capas"
      title="Panel y toasts"
      note="Un solo componente para la hoja de móvil y el panel lateral de escritorio: es un <dialog> nativo y lo único que cambia es de dónde entra. En ≥1440 px existe además la variante persistente, que no tapa la grilla."
    >
      <Fila>
        <Button
          variant="primary"
          onClick={() => {
            setSucio(false);
            setAbierto(true);
          }}
        >
          Abrir el panel
        </Button>
        <Button
          onClick={() => {
            setSucio(true);
            setAbierto(true);
          }}
        >
          Abrir con cambios sin guardar
        </Button>
      </Fila>

      <Panel
        open={abierto}
        onClose={() => setAbierto(false)}
        dismissable={!sucio}
        title="Cita · Marcela Ríos"
        footer={
          <>
            <Button onClick={() => setAbierto(false)}>Cerrar</Button>
            <Button
              variant="primary"
              onClick={() => {
                setAbierto(false);
                toast({ message: "Cita guardada.", tone: "ok" });
              }}
            >
              Guardar
            </Button>
          </>
        }
      >
        <div style={{ display: "grid", gap: "0.875rem" }}>
          {sucio ? (
            <div className="ui-readonly" role="status">
              <Icon name="info" size={16} className="ui-readonly__icon" />
              <span>
                Este panel se abrió con <strong>cambios sin guardar</strong>:
                Escape y tocar el fondo no lo cierran. Se pierde el trabajo en un
                gesto y ese gesto es demasiado fácil de hacer sin querer.
              </span>
            </div>
          ) : null}
          <Fila>
            <StatusPill status="confirmada" />
            <span style={{ color: "var(--color-ink-soft)" }}>
              {formatTimeRange("2026-08-31 09:00:00", "2026-08-31 11:00:00")} ·
              Lina
            </span>
          </Fila>
          <Field label="Servicio">
            {(ids) => (
              <Select {...ids} defaultValue="acr">
                <option value="acr">Acrílicas esculpidas</option>
                <option value="semi">Semipermanente</option>
              </Select>
            )}
          </Field>
          <Field label="Notas de la cita">
            {(ids) => <TextArea {...ids} rows={4} />}
          </Field>
          <SkeletonText lines={4} />
        </div>
      </Panel>

      <div>
        <Rotulo>Panel persistente (≥1440 px, al lado de la grilla)</Rotulo>
        <div
          style={{
            marginTop: "0.5rem",
            height: "17rem",
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) minmax(0,22rem)",
            border: "1px solid var(--hair)",
            borderRadius: "var(--radius-md)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "var(--color-ivory-deep)",
              display: "grid",
              placeItems: "center",
              color: "var(--color-ink-soft)",
              fontSize: "var(--text-2xs)",
            }}
          >
            la grilla de la agenda sigue acá
          </div>
          <PanelInline title="Cita · Ana" onClose={() => {}}>
            <div style={{ display: "grid", gap: "0.75rem" }}>
              <StatusPill status="completada" />
              <div style={{ fontWeight: 700, fontSize: "var(--text-lg)" }}>
                {formatCOP(95000)}
              </div>
              <SkeletonText lines={3} />
            </div>
          </PanelInline>
        </div>
      </div>

      <div>
        <Rotulo>Toasts</Rotulo>
        <Fila>
          <Button size="sm" onClick={() => toast({ message: "Guardado." })}>
            neutral
          </Button>
          <Button
            size="sm"
            onClick={() => toast({ message: "Día cerrado.", tone: "ok" })}
          >
            ok
          </Button>
          <Button
            size="sm"
            onClick={() =>
              toast({
                message: "Hay una cita completada sin cuenta.",
                tone: "warn",
              })
            }
          >
            warn
          </Button>
          <Button
            size="sm"
            onClick={() =>
              toast({
                message: "No se pudo guardar. Easy!Appointments no responde.",
                tone: "error",
              })
            }
          >
            error (no se va solo)
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              toast({
                message: "Cita cancelada.",
                undo: {
                  onUndo: () => {
                      toast({ message: "Cita restaurada.", tone: "ok" });
                    },
                },
              })
            }
          >
            con Deshacer
          </Button>
        </Fila>
        <p
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--color-ink-soft)",
            marginTop: "0.375rem",
            maxWidth: "62ch",
          }}
        >
          Si hay Deshacer, <strong>la escritura ya ocurrió</strong>: el toast
          revierte, no retrasa. Retrasarla dejaría la agenda mintiendo mientras
          corre el reloj, y que dos personas editen a la vez es el caso normal.
          El temporizador se pausa con el puntero encima o con el foco adentro.
        </p>
      </div>
    </Seccion>
  );
}

function Carga() {
  return (
    <Seccion
      id="carga"
      title="Cargando"
      note="Esqueletos con la forma del contenido. Nada de spinner en el centro de la pantalla: un esqueleto dice qué va a llegar y dónde."
    >
      <LoadingRegion label="Cargando el resumen del día">
        <div
          style={{
            display: "grid",
            gap: "0.625rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
          }}
        >
          <SkeletonStat />
          <SkeletonStat />
          <SkeletonStat />
        </div>
      </LoadingRegion>

      <div className="ui-card" style={{ overflow: "hidden" }}>
        <DataTable
          columns={COLUMNAS}
          rows={[]}
          rowKey={(r) => r.id}
          caption="Citas"
          loading
        />
      </div>

      <div>
        <Rotulo>Piezas sueltas</Rotulo>
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
          <Skeleton height={10} width="30%" />
          <SkeletonText lines={3} />
        </div>
      </div>
    </Seccion>
  );
}

function Vacios() {
  return (
    <Seccion
      id="vacios"
      title="Vacíos que enseñan la interfaz"
      note="«Sin resultados» no le sirve a nadie. Un vacío contesta qué debería haber, por qué no hay nada, y cuál es el siguiente gesto."
    >
      <div
        style={{
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(19rem, 1fr))",
        }}
      >
        <div className="ui-card">
          <EmptyState
            icon="agenda"
            title="Todavía no hay citas hoy"
            body="Cuando la recepción agende la primera, aparece acá con su hora, la profesional y el estado."
            action={
              <Button variant="primary" icon="mas-signo">
                Nueva cita
              </Button>
            }
          />
        </div>
        <div className="ui-card">
          <EmptyState
            icon="buscar"
            title="Ninguna clienta con «mar»"
            body="La búsqueda mira nombre y teléfono. Prueba con el número completo, que es la identidad de la ficha."
            action={<Button>Limpiar la búsqueda</Button>}
            secondary={<Button variant="ghost">Crear una ficha nueva</Button>}
          />
        </div>
        <div className="ui-card">
          <EmptyState
            icon="caja"
            title="Nada pendiente de cobrar"
            body="Todas las citas completadas de hoy ya tienen su cuenta. El día se puede cerrar."
            action={<Button variant="primary">Cerrar el día</Button>}
          />
        </div>
      </div>
    </Seccion>
  );
}

function Sistema() {
  return (
    <Seccion
      id="sistema"
      title="Estados de sistema"
      note="Los tres que este panel sí va a ver. El de arriba es el que más importa: MySQL sigue vivo, así que la agenda y los reportes se ven y nada se puede guardar."
    >
      <div style={{ border: "1px solid var(--hair)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
        <ReadOnlyBand since="desde las 3:12 p. m." detailsHref="#" />
      </div>
      <div style={{ border: "1px solid var(--hair)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
        <ReadOnlyBand reason="La base de datos del panel está en mantenimiento" />
      </div>

      <div>
        <Rotulo>Iconos</Rotulo>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.875rem",
            marginTop: "0.5rem",
          }}
        >
          {(
            [
              "hoy",
              "agenda",
              "caja",
              "clientas",
              "mas",
              "cita",
              "servicios",
              "equipo",
              "comisiones",
              "reportes",
              "diagnostico",
              "externo",
              "mas-signo",
              "buscar",
              "cerrar",
              "chevron-izq",
              "chevron-der",
              "chevron-abajo",
              "check",
              "alerta",
              "info",
              "deshacer",
              "candado",
              "reloj",
            ] as const
          ).map((n) => (
            <div
              key={n}
              style={{
                display: "grid",
                justifyItems: "center",
                gap: "0.25rem",
                width: "4.5rem",
              }}
            >
              <Icon name={n} size={22} />
              <span
                style={{
                  fontSize: "0.625rem",
                  color: "var(--color-ink-soft)",
                  textAlign: "center",
                }}
              >
                {n}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Seccion>
  );
}
