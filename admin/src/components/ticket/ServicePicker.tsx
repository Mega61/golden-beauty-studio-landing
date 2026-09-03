"use client";

import { useId, useMemo, useState } from "react";

import { Icon, TextInput, formatCOP, formatDuration } from "@/components/ui";
import {
  filterGroups,
  findService,
  groupServicesForPicker,
  mainServices,
  type TicketCatalog,
} from "./catalog";

/**
 * Paso 1 — **¿Qué se hizo?**
 *
 * Viene con el servicio agendado ya elegido y cambiarlo es un toque. Tres
 * decisiones que se ven en el código y conviene no deshacer:
 *
 * - **La lista abre plegada.** El caso mayoritario es que lo agendado sea lo
 *   realizado; obligar a confirmar una elección que ya está hecha son dos
 *   gestos por cuenta, cada día, para nada.
 * - **Se despliega en línea, no en otra hoja.** La cuenta ya vive dentro de un
 *   `<dialog>` modal; un segundo diálogo encima pelea la trampa de foco y en un
 *   celular tapa el contexto del que hay que salir para volver.
 * - **Radios de verdad**, no `<div role="option">`. El grupo se recorre con las
 *   flechas, el lector de pantalla anuncia "3 de 27" y el `<label>` hace que
 *   toda la fila —no un círculo de 18 px— sea el área táctil.
 *
 * La marca de "cambió" aparece en cuanto lo elegido difiere de lo agendado. No
 * es una advertencia: es el dato de negocio del que sale "la mitad de los
 * press-on terminan en forrado", y por eso se muestra sin dramatismo.
 */
export function ServicePicker({
  catalog,
  value,
  bookedServiceId,
  disabled = false,
  onChange,
}: {
  catalog: TicketCatalog;
  value: number | null;
  bookedServiceId: number | null;
  disabled?: boolean;
  onChange: (eaServiceId: number) => void;
}) {
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () => groupServicesForPicker(catalog, value ?? bookedServiceId),
    [catalog, value, bookedServiceId],
  );
  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);

  const selected = findService(catalog, value);
  const cambio = value !== null && bookedServiceId !== null && value !== bookedServiceId;
  // Con un catálogo corto el buscador es una fila de cromo que no ahorra nada;
  // con veintisiete servicios en un celular es la única forma de llegar al de
  // abajo sin desplazar media pantalla.
  const conBuscador = mainServices(catalog).length > 8;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={groupId}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          minHeight: "var(--hit)",
          width: "100%",
          padding: "0.5rem 0.75rem",
          textAlign: "left",
          background: "var(--color-paper)",
          border: "1px solid var(--hair-strong)",
          borderRadius: "var(--radius-md)",
          color: "inherit",
          font: "inherit",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: "var(--color-carbon)",
            }}
          >
            {selected ? selected.name : "Elegí el servicio"}
          </span>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-2xs)",
              color: "var(--color-ink-soft)",
            }}
          >
            {selected
              ? [
                  selected.categoryName || "Sin categoría",
                  selected.listPrice === null ? "sin precio en EA" : formatCOP(selected.listPrice),
                  selected.durationMin === null ? null : formatDuration(selected.durationMin),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "La cita de EA no traía servicio"}
          </span>
        </span>

        {cambio ? <CambioTag /> : null}

        <Icon name={open ? "chevron-abajo" : "chevron-der"} size={18} />
      </button>

      {open ? (
        <div
          id={groupId}
          style={{
            border: "1px solid var(--hair)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-paper)",
            overflow: "hidden",
          }}
        >
          {conBuscador ? (
            <div style={{ padding: "0.5rem", borderBottom: "1px solid var(--hair)" }}>
              <TextInput
                id={`${groupId}-q`}
                type="search"
                placeholder="Buscar servicio"
                value={query}
                aria-label="Buscar servicio"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}

          <div
            role="radiogroup"
            aria-label="Servicio realizado"
            // El tope de alto deja siempre visible el pie de la hoja: sin él,
            // elegir un servicio de la última categoría empuja el botón de
            // guardar fuera de la pantalla y parece que desapareció.
            style={{ maxHeight: "22rem", overflowY: "auto" }}
          >
            {visible.length === 0 ? (
              <p
                style={{
                  padding: "1rem",
                  margin: 0,
                  color: "var(--color-ink-soft)",
                }}
              >
                Ningún servicio coincide con “{query}”.
              </p>
            ) : (
              visible.map((group) => (
                <section key={group.categoryName}>
                  <h4
                    style={{
                      position: "sticky",
                      top: 0,
                      margin: 0,
                      padding: "0.375rem 0.75rem",
                      background: "var(--color-cream)",
                      borderBottom: "1px solid var(--hair)",
                      fontSize: "var(--text-2xs)",
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      color: "var(--color-ink-soft)",
                    }}
                  >
                    {group.categoryName}
                  </h4>

                  {group.services.map((service) => {
                    const checked = service.eaServiceId === value;
                    return (
                      <label
                        key={service.eaServiceId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.75rem",
                          minHeight: "var(--hit)",
                          padding: "0.5rem 0.75rem",
                          borderBottom: "1px solid var(--hair)",
                          background: checked ? "var(--color-gold-pale)" : "transparent",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="radio"
                          name={groupId}
                          checked={checked}
                          disabled={disabled}
                          onChange={() => {
                            onChange(service.eaServiceId);
                            setOpen(false);
                            setQuery("");
                          }}
                          style={{ width: 18, height: 18, accentColor: "var(--color-gold-dark)" }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: checked ? 600 : 400 }}>
                            {service.name}
                          </span>
                          {service.durationMin !== null ? (
                            <span
                              style={{
                                display: "block",
                                fontSize: "var(--text-2xs)",
                                color: "var(--color-ink-soft)",
                              }}
                            >
                              {formatDuration(service.durationMin)}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className="ui-num"
                          style={{
                            color:
                              service.listPrice === null
                                ? "var(--color-warn-ink)"
                                : "var(--color-ink)",
                          }}
                        >
                          {service.listPrice === null ? "sin precio" : formatCOP(service.listPrice)}
                        </span>
                      </label>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * La marca de "cambió".
 *
 * Lleva punto y palabra, como las pastillas de estado, por la misma razón: en
 * una hoja impresa en blanco y negro y en deuteranopía el color solo no dice
 * nada. Usa el tinte de `confirmada` porque no es un error ni una alerta — es
 * información, y teñirla de ámbar la convertiría en un reproche a la técnica.
 */
export function CambioTag() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3125rem",
        flex: "none",
        padding: "0.125rem 0.4375rem",
        borderRadius: "999px",
        background: "var(--color-st-confirmada-tint)",
        border: "1px solid var(--color-st-confirmada-line)",
        color: "var(--color-st-confirmada-ink)",
        fontSize: "var(--text-2xs)",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--color-st-confirmada-dot)",
        }}
      />
      cambió
    </span>
  );
}
