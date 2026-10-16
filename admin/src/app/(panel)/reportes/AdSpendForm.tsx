"use client";

import { useActionState, useState } from "react";

import { Button, Field, MoneyInput, Select } from "@/components/ui";
import type { AdChannel } from "@/db/types";

import { AD_CHANNEL_LABEL, AD_CHANNELS, AD_SPEND_MAX } from "./acquisition";
import { guardarInversion, type AdSpendActionResult } from "./actions";

/**
 * "Inversión en anuncios del mes" — el formulario de la dueña dentro del
 * reporte de costo por clienta nueva.
 *
 * Va plegado: se usa una vez al mes, copiando la cifra del Administrador de
 * anuncios, y desplegado le quitaría a la pantalla el lugar de los números que
 * se miran todos los días. Solo se dibuja para quien tiene `pauta:registrar`;
 * la acción lo vuelve a preguntar igual.
 *
 * No calcula nada: recoge cadenas. Qué es un monto válido lo decide
 * `parseAdSpendForm()` en el servidor.
 */
export function AdSpendForm({ defaultMonth }: { defaultMonth: string }) {
  const [state, action, pending] = useActionState<AdSpendActionResult | null, FormData>(
    guardarInversion,
    null,
  );
  const [amount, setAmount] = useState<number | null>(null);

  return (
    <details>
      <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600 }}>
        Inversión en anuncios del mes
      </summary>

      <form
        action={action}
        style={{
          display: "grid",
          gap: "0.75rem",
          // Dos columnas desde que caben dos campos de 14rem; en el celular,
          // una. `start` y no `end`: el campo de plata trae una ayuda debajo y
          // alinear por abajo descuadraba la fila entera.
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
          alignItems: "start",
          marginTop: "0.75rem",
          paddingTop: "0.75rem",
          borderTop: "1px solid var(--hair)",
        }}
      >
        <Field label="Mes" required>
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              className="ui-input"
              defaultValue={defaultMonth}
              name="month"
              required
              type="month"
            />
          )}
        </Field>

        <Field label="Canal" required>
          {({ id, describedBy }) => (
            <Select defaultValue={"meta" satisfies AdChannel} describedBy={describedBy} id={id} name="channel">
              {AD_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {AD_CHANNEL_LABEL[channel]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <MoneyInput
          hint="Lo que cobró la plataforma ese mes. Cero si no se pautó."
          label="Inversión"
          max={AD_SPEND_MAX}
          name="amount"
          onValueChange={setAmount}
          required
          value={amount}
        />

        <Field label="Nota (opcional)">
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              className="ui-input"
              maxLength={500}
              name="notes"
              placeholder="Campaña, público, lo que sirva recordar"
            />
          )}
        </Field>

        <div
          style={{
            gridColumn: "1 / -1",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.5rem 1rem",
          }}
        >
          <Button loading={pending} loadingLabel="Guardando" type="submit" variant="primary">
            Guardar inversión
          </Button>
          <p className="ui-hint" style={{ margin: 0 }}>
            Guardar el mismo mes y canal otra vez reemplaza la cifra; el cambio queda en la bitácora.
          </p>
        </div>

        {state ? (
          <p
            role="status"
            style={{
              gridColumn: "1 / -1",
              margin: 0,
              fontSize: "var(--text-2xs)",
              color: state.ok ? "var(--color-ok-ink)" : "var(--color-error-ink)",
            }}
          >
            {state.message}
          </p>
        ) : null}
      </form>
    </details>
  );
}
