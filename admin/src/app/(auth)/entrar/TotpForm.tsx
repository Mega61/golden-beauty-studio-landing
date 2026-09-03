"use client";

import { useActionState, useState } from "react";

import { Button, Field, TextInput } from "@/components/ui";
import type { TotpLoginCandidate } from "@/lib/auth";
import { entrarConCodigo, type TotpFormState } from "./actions";

/**
 * "Cara y código": la grilla de nombres más seis dígitos.
 *
 * El estudio tiene tres personas. Tocar un nombre es más rápido en un celular,
 * entre dos clientas y con las manos ocupadas, que escribir un correo. **Eso no
 * debilita nada: el nombre nunca fue el secreto.**
 *
 * El nombre y el código están en un solo formulario y en dos pasos visuales — se
 * elige, y recién ahí aparece el campo. Dos pantallas separadas obligarían a
 * volver atrás para corregir un toque equivocado; un campo siempre visible
 * invita a escribir el código antes de decir quién es y a que el envío falle
 * por un motivo que no es el código.
 */
export function TotpForm({ people }: { people: readonly TotpLoginCandidate[] }) {
  const [selected, setSelected] = useState<TotpLoginCandidate | null>(null);
  const [state, formAction, pending] = useActionState<TotpFormState, FormData>(
    entrarConCodigo,
    { error: null },
  );
  if (people.length === 0) return null;

  return (
    <section aria-labelledby="totp-title" style={{ display: "grid", gap: "0.75rem" }}>
      <h2
        id="totp-title"
        style={{
          fontSize: "var(--text-2xs)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--color-ink-soft)",
        }}
      >
        Equipo
      </h2>

      <div
        role="radiogroup"
        aria-label="Quién eres"
        style={{
          display: "grid",
          // `auto-fit` y no un número de columnas: con dos personas quedan dos
          // botones anchos, con cinco se acomodan solas. El mínimo de 8rem
          // mantiene el área táctil por encima de los 44 px en 390 px de ancho.
          gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
          gap: "0.5rem",
        }}
      >
        {people.map((person) => {
          const isSelected = selected?.userId === person.userId;
          return (
            <button
              key={person.userId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(person)}
              className="ui-btn ui-btn--secondary ui-btn--block"
              style={{
                justifyContent: "flex-start",
                minHeight: "var(--hit)",
                background: isSelected ? "var(--color-gold-pale)" : undefined,
                borderColor: isSelected ? "var(--color-gold-dark)" : undefined,
              }}
            >
              {person.name}
              {person.locked ? (
                <span
                  style={{
                    marginInlineStart: "auto",
                    fontSize: "var(--text-2xs)",
                    color: "var(--color-error-ink)",
                  }}
                >
                  bloqueada
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {selected?.locked ? (
        <p
          role="status"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--color-error-ink)",
            background: "var(--color-error-tint)",
            border: "1px solid var(--color-error-line)",
            borderRadius: "var(--radius-md)",
            padding: "0.625rem 0.75rem",
          }}
        >
          Esta cuenta quedó bloqueada por intentos fallidos. Pídele a la dueña que
          la libere desde Equipo; el código nuevo no va a servir hasta entonces.
        </p>
      ) : null}

      {selected && !selected.locked ? (
        <form action={formAction} style={{ display: "grid", gap: "0.75rem" }}>
          <input type="hidden" name="userId" value={selected.userId} />
          <Field
            label="Código de tu app"
            hint="Seis dígitos. Cambia cada 30 segundos."
            error={state.error ?? undefined}
            required
          >
            {(ids) => (
              <TextInput
                {...ids}
                name="code"
                // Al elegir un nombre el campo aparece y toma el foco: el
                // teclado numérico se abre solo y son dos toques menos en el
                // peor momento posible. Es aceptable acá y solo acá — el campo
                // se monta como respuesta a un toque de la usuaria, no al
                // cargar la página.
                autoFocus
                // `inputMode` y no `type="number"`: el spinner de un input
                // numérico no tiene sentido acá y en algunos navegadores se
                // come los ceros a la izquierda, que en un TOTP son datos.
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                placeholder="000000"
                required
                style={{
                  fontSize: "var(--text-lg)",
                  letterSpacing: "0.3em",
                  textAlign: "center",
                }}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" block loading={pending}>
            Entrar
          </Button>
        </form>
      ) : null}
    </section>
  );
}
