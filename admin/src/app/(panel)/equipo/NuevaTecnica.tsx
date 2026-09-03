"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";

import { crearCuentaTecnica, type ActionResult } from "./actions";

/**
 * Alta de una técnica en el panel.
 *
 * **El correo es real y es el personal de ella.** No hay campo opcional ni
 * valor por defecto: es el mismo correo al que se le comparte su calendario de
 * Google en solo lectura, y es la llave con la que `verifySession()` cruza la
 * allowlist en cada request. Un correo inventado acá tendría el mismo problema
 * que un correo inventado en la ficha de una clienta, con el agravante de que
 * además es una credencial.
 *
 * El desplegable de profesionales es lo que la ata a su columna de la agenda:
 * sin `ea_provider_id`, una sesión `staff` no alcanza **nada** —`ownsProvider()`
 * responde que no— y la técnica entraría a un panel vacío.
 */
export function NuevaTecnica({
  profesionales,
}: {
  profesionales: ReadonlyArray<{ id: number; name: string }>;
}) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null, FormData>(
    crearCuentaTecnica,
    null,
  );

  return (
    <form
      action={enviar}
      style={{
        display: "grid",
        gap: "0.75rem",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
        alignItems: "end",
      }}
    >
      <div className="ui-field">
        <label className="ui-label" htmlFor="nueva-name">
          Nombre
          <span className="ui-sr"> (obligatorio)</span>
        </label>
        <input id="nueva-name" name="name" className="ui-input" required maxLength={120} />
        <span className="ui-hint">Como va a aparecer en la grilla del login.</span>
      </div>

      <div className="ui-field">
        <label className="ui-label" htmlFor="nueva-email">
          Correo personal
          <span className="ui-sr"> (obligatorio)</span>
        </label>
        <input
          id="nueva-email"
          name="email"
          type="email"
          className="ui-input"
          required
          maxLength={255}
          placeholder="nombre@gmail.com"
        />
        <span className="ui-hint">El mismo al que se le comparte su calendario.</span>
      </div>

      <div className="ui-field">
        <label className="ui-label" htmlFor="nueva-provider">
          Profesional en la agenda
        </label>
        <select id="nueva-provider" name="eaProviderId" className="ui-select" defaultValue="">
          <option value="">Sin enlazar todavía</option>
          {profesionales.map((persona) => (
            <option key={persona.id} value={persona.id}>
              {persona.name}
            </option>
          ))}
        </select>
        <span className="ui-hint">Sin esto no ve ninguna cita como suya.</span>
      </div>

      <div>
        <Button type="submit" variant="primary" loading={enviando} loadingLabel="Creando">
          Agregar al panel
        </Button>
      </div>

      {estado ? (
        <p
          role="status"
          style={{
            gridColumn: "1 / -1",
            margin: 0,
            fontSize: "var(--text-2xs)",
            color: estado.ok ? "var(--color-ok-ink)" : "var(--color-error-ink)",
          }}
        >
          {estado.message}
        </p>
      ) : null}
    </form>
  );
}
