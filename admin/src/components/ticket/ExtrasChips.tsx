"use client";

import { useMemo, useState } from "react";

import { Icon, formatCOP } from "@/components/ui";
import { FEATURED_EXTRAS, orderExtras, type CatalogService, type TicketCatalog } from "./catalog";

/**
 * Paso 2 — **Adicionales**, con contador.
 *
 * El gesto real es "tres uñas con diseño": un chip que se toca tres veces, no
 * un campo de cantidad que hay que enfocar, seleccionar y reescribir con una
 * mano mientras se sostiene el celular con la otra.
 *
 * - **`+` y `−` miden 44 px** y están separados, porque el error caro es restar
 *   cuando se quería sumar y no notarlo hasta el cierre del día.
 * - **Los cinco primeros se ven sin desplegar nada.** El resto vive detrás de
 *   "Ver todos": una lista de doce adicionales en un celular obliga a desplazar
 *   por delante del total, y entonces el total deja de estar a la vista.
 * - **El contador se anuncia**, no solo se pinta: `aria-live` en la cifra, para
 *   que quien no ve el número sepa en cuánto quedó después de tocar.
 *
 * Si EA no tiene una categoría de adicionales, acá no hay chips y la sección lo
 * dice con todas las letras. Ofrecer montajes como adicionales para no dejar el
 * hueco vacío sería peor que el hueco.
 */
export function ExtrasChips({
  catalog,
  quantities,
  disabled = false,
  onChange,
}: {
  catalog: TicketCatalog;
  /** `{ [eaServiceId]: cantidad }`. Sin la clave = cero. */
  quantities: Readonly<Record<string, number>>;
  disabled?: boolean;
  onChange: (eaServiceId: number, delta: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const extras = useMemo(() => orderExtras(catalog), [catalog]);

  if (extras.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          padding: "0.75rem",
          borderRadius: "var(--radius-md)",
          background: "var(--color-ivory-deep)",
          color: "var(--color-ink-soft)",
        }}
      >
        No hay una categoría <strong>extras</strong> en Easy!Appointments, así que no hay
        adicionales para marcar. Se pueden cobrar escribiendo el total a mano, o creando la
        categoría en EA.
      </p>
    );
  }

  // Los que ya tienen cantidad se muestran siempre, aunque estén más abajo del
  // corte: esconder un adicional que la técnica acaba de marcar sería hacerle
  // dudar de si el toque contó.
  const marcados = new Set(
    extras.filter((s) => (quantities[String(s.eaServiceId)] ?? 0) > 0).map((s) => s.eaServiceId),
  );
  const visibles = expanded
    ? extras
    : extras.filter((s, i) => i < FEATURED_EXTRAS || marcados.has(s.eaServiceId));
  const ocultos = extras.length - visibles.length;

  return (
    <div style={{ display: "grid", gap: "0.375rem" }}>
      {visibles.map((service) => (
        <ExtraRow
          key={service.eaServiceId}
          service={service}
          qty={quantities[String(service.eaServiceId)] ?? 0}
          disabled={disabled}
          onChange={onChange}
        />
      ))}

      {ocultos > 0 || expanded ? (
        <button
          type="button"
          className="ui-btn ui-btn--ghost"
          onClick={() => setExpanded((v) => !v)}
          style={{ justifySelf: "start" }}
        >
          {expanded ? "Ver menos" : `Ver todos (${ocultos} más)`}
        </button>
      ) : null}
    </div>
  );
}

function ExtraRow({
  service,
  qty,
  disabled,
  onChange,
}: {
  service: CatalogService;
  qty: number;
  disabled: boolean;
  onChange: (eaServiceId: number, delta: number) => void;
}) {
  const activo = qty > 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        minHeight: "var(--hit)",
        padding: "0.25rem 0.25rem 0.25rem 0.75rem",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${activo ? "var(--color-gold)" : "var(--hair)"}`,
        background: activo ? "var(--color-gold-pale)" : "var(--color-paper)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontWeight: activo ? 600 : 400,
            color: "var(--color-carbon)",
          }}
        >
          {service.name}
        </span>
        <span
          className="ui-num"
          style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}
        >
          {service.listPrice === null ? "sin precio en EA" : `${formatCOP(service.listPrice)} c/u`}
        </span>
      </span>

      <Stepper service={service} qty={qty} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/**
 * El menos.
 *
 * El set de iconos de A3 no tiene uno —nadie lo había necesitado— y no es de
 * este paquete agregarlo a `Icon.tsx`. Se dibuja acá con la misma retícula de
 * 24, el mismo `stroke-width` de 1.6 y el mismo remate redondo, para que al
 * lado del `mas-signo` se lea como el mismo alfabeto. El día que `Icon` gane un
 * `menos`, esto se borra.
 */
function MinusGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden
      focusable="false"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

function Stepper({
  service,
  qty,
  disabled,
  onChange,
}: {
  service: CatalogService;
  qty: number;
  disabled: boolean;
  onChange: (eaServiceId: number, delta: number) => void;
}) {
  return (
    <span style={{ display: "flex", alignItems: "center", flex: "none" }}>
      <button
        type="button"
        className="ui-btn ui-btn--ghost ui-btn--icon"
        disabled={disabled || qty === 0}
        aria-label={`Quitar uno de ${service.name}`}
        onClick={() => onChange(service.eaServiceId, -1)}
      >
        <MinusGlyph />
      </button>

      <span
        className="ui-num"
        aria-live="polite"
        aria-atomic="true"
        style={{
          minWidth: "2ch",
          textAlign: "center",
          fontSize: "var(--text-md)",
          fontWeight: 600,
          color: qty === 0 ? "var(--color-ink-mute)" : "var(--color-carbon)",
        }}
      >
        <span className="ui-sr">{service.name}: </span>
        {qty}
      </span>

      <button
        type="button"
        className="ui-btn ui-btn--secondary ui-btn--icon"
        disabled={disabled}
        aria-label={`Agregar uno de ${service.name}`}
        onClick={() => onChange(service.eaServiceId, 1)}
      >
        <Icon name="mas-signo" size={16} />
      </button>
    </span>
  );
}
