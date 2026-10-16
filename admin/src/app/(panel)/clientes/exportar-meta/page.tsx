import type { Metadata } from "next";

import { AppShell } from "@/components/shell";
import type { Role } from "@/components/shell/nav";
import { EmptyState, ReadOnlyBand } from "@/components/ui";
import type { UserRole } from "@/db/types";
import { can } from "@/lib/auth-policy";
import { requireSession } from "@/lib/dal";

import { META_SEGMENTS } from "../meta-export";
import { loadMetaAudience } from "../meta-export-data";

/**
 * `/admin/clientes/exportar-meta` — bajar la lista de clientas para una
 * audiencia personalizada de Meta.
 *
 * La pantalla muestra cuántas clientas caen en cada segmento y cuántas quedan
 * fuera por no tener teléfono **antes** de bajar nada: un archivo de 40 filas
 * cuando se esperaban 400 tiene que poder verse aquí, no descubrirse en el
 * Administrador de anuncios.
 *
 * La descarga es un `<form method="get">` normal hacia el Route Handler, sin
 * JavaScript: un archivo se baja con una navegación del navegador, y así el
 * permiso y la bitácora se resuelven en un solo lugar del servidor.
 */

export const metadata: Metadata = {
  title: "Exportar para Meta · Clientes · Panel",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

function navRole(role: UserRole): Role {
  return role === "admin" ? "reception" : role;
}

const text: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-ink-soft)",
  maxWidth: "68ch",
};

export default async function ExportarMetaPage() {
  // La sesión primero y el permiso después, para poder dibujar el vacío con la
  // navegación de quien llegó. La pregunta de verdad se repite en el Route
  // Handler: esta pantalla no entrega nada.
  const session = await requireSession();
  const role: UserRole = session.role;
  if (!can(role, "clientes:exportar")) {
    return (
      <AppShell role={navRole(role)} title="Exportar para Meta">
        <EmptyState
          icon="candado"
          title="Exportar la clientela es solo de administración"
          body="Es una exportación masiva de datos personales hacia Meta. Aunque va cifrada, solo administración la baja, y cada descarga queda en la bitácora."
        />
      </AppShell>
    );
  }

  const load = await loadMetaAudience();

  return (
    <AppShell role={navRole(role)} title="Exportar para Meta">
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <a className="ui-btn ui-btn--ghost ui-btn--sm" href="/admin/clientes" style={{ justifySelf: "start" }}>
          ← Clientes
        </a>

        <section className="ui-card">
          <header className="ui-card__head">
            <h2 className="ui-card__title">Lista de clientes para Meta</h2>
          </header>

          <div style={{ display: "grid", gap: "1rem", padding: "0.75rem 1rem 1rem" }}>
            <p style={text}>
              Un archivo CSV con el teléfono, el nombre y el país de cada cliente,{" "}
              <strong>cifrados con SHA-256</strong> en el formato de lista de clientes de Meta. Ningún
              dato viaja en claro: Meta compara los cifrados contra los suyos y nunca ve el número.
              Las fichas de la agenda y las del histórico de Agenda Pro se unen por teléfono.
            </p>

            {!load.ok ? (
              <ReadOnlyBand reason={load.message} detailsHref="/diagnostico" />
            ) : (
              <>
                <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.5rem" }}>
                  {META_SEGMENTS.map((segment) => (
                    <li key={segment.id} style={{ fontSize: "var(--text-sm)" }}>
                      <strong>{segment.label}</strong>{" "}
                      <span className="ui-num">
                        — {load.counts[segment.id]} persona{load.counts[segment.id] === 1 ? "" : "s"}
                      </span>
                      <br />
                      <span style={{ color: "var(--color-ink-soft)" }}>{segment.use}</span>
                    </li>
                  ))}
                </ul>

                {load.audience.customersWithoutPhone + load.audience.legacyWithoutPhone > 0 ? (
                  <p style={text}>
                    <strong>Quedan fuera por no tener teléfono utilizable:</strong>{" "}
                    {load.audience.customersWithoutPhone} ficha
                    {load.audience.customersWithoutPhone === 1 ? "" : "s"} de la agenda y{" "}
                    {load.audience.legacyWithoutPhone} cita
                    {load.audience.legacyWithoutPhone === 1 ? "" : "s"} del histórico. El teléfono es
                    la identidad de cada cliente: sin él no hay nada que Meta pueda comparar. Corregirlo
                    en su ficha la suma a la próxima descarga.
                  </p>
                ) : null}

                <form
                  action="/admin/clientes/exportar-meta/descargar"
                  method="get"
                  style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "end", maxWidth: "40rem" }}
                >
                  <div className="ui-field" style={{ flex: "1 1 16rem", minWidth: 0 }}>
                    <label className="ui-label" htmlFor="segmento">
                      Segmento
                    </label>
                    <select className="ui-select" defaultValue="ultimos-180" id="segmento" name="segmento">
                      {META_SEGMENTS.map((segment) => (
                        <option key={segment.id} value={segment.id}>
                          {segment.label} ({load.counts[segment.id]})
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="ui-btn ui-btn--primary" type="submit">
                    Descargar CSV
                  </button>
                </form>
              </>
            )}

            <details>
              <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600 }}>
                Cómo subirla en el Administrador de anuncios
              </summary>
              <p style={{ ...text, marginTop: "0.5rem" }}>
                En el Administrador de anuncios, ve a <strong>Públicos</strong> → <strong>Crear
                público</strong> → <strong>Público personalizado</strong> → <strong>Lista de
                clientes</strong> y sube el archivo; Meta reconoce las columnas solas y avisa que ya
                vienen cifradas. Con la lista de quienes <em>vinieron en los últimos 180 días</em>, abre el
                conjunto de anuncios de la campaña de captación y, en <strong>Público</strong>, usa{" "}
                <strong>Excluir</strong> con ese público: así la pauta de «primera visita» no se gasta
                en quien ya es cliente. La de <em>sin venir hace más de 60 días</em> va al revés: como
                público <strong>incluido</strong> de una campaña para volver a traer a esas personas. Baja una lista
                nueva cada mes; Meta no la actualiza sola.
              </p>
            </details>

            <p style={{ ...text, fontSize: "var(--text-2xs)" }}>
              Cada descarga queda en la bitácora con el segmento y el número de filas, nunca con los
              datos. Quienes pidieron no recibir recordatorios por WhatsApp <strong>sí</strong>{" "}
              van en la lista: pidieron que no se les escriba, y esta lista no le escribe a nadie —sirve
              sobre todo para <em>no</em> mostrarles anuncios de captación.
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
