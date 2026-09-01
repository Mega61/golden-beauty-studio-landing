"use client";

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./Icon";

/**
 * Campos de formulario.
 *
 * El plan pide `<label>` real en cada campo y resumen de errores al enviar un
 * formulario largo. Acá eso no es una recomendación: `Field` genera el `id`,
 * lo cablea al `<label>`, arma el `aria-describedby` con la ayuda y el error,
 * y pone `aria-invalid`. No hay forma de usar `TextInput` sin etiqueta — no
 * acepta la prop.
 *
 * `placeholder` **no** sustituye a la etiqueta y no debería llevar el nombre
 * del campo: desaparece al escribir, y a la mitad de un formulario largo nadie
 * recuerda qué iba en la casilla vacía. Sirve para el formato de ejemplo
 * (`300 123 4567`), y para eso está el tono `ink-soft`, que mide 7.98:1 —
 * `ink-mute`, el gris habitual de placeholder, se queda en 3.53:1 sobre crema y
 * no llega al piso.
 */

type FieldShellProps = {
  label: string;
  /** Texto de apoyo permanente. Va antes del error, no después. */
  hint?: string;
  /** Mensaje de error. Nombra el problema y la salida, no solo "inválido". */
  error?: string;
  required?: boolean;
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => ReactNode;
};

export function Field({
  label,
  hint,
  error,
  required = false,
  children,
}: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy =
    [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className="ui-field">
      <label className="ui-label" htmlFor={id}>
        {label}
        {required ? (
          <span className="ui-label__req" aria-hidden>
            *
          </span>
        ) : null}
        {required ? <span className="ui-sr"> (obligatorio)</span> : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <span className="ui-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="ui-error" id={errId}>
          <Icon name="alerta" size={14} style={{ marginTop: 1, flex: "none" }} />
          {error}
        </span>
      ) : null}
    </div>
  );
}

type Wired = { id: string; describedBy?: string; invalid?: boolean };

export function TextInput({
  id,
  describedBy,
  invalid,
  loading,
  ...rest
}: Wired & { loading?: boolean } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "id" | "className"
  >) {
  return (
    <input
      {...rest}
      id={id}
      className="ui-input"
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      data-loading={loading ? "true" : undefined}
      readOnly={rest.readOnly ?? loading}
    />
  );
}

export function TextArea({
  id,
  describedBy,
  invalid,
  ...rest
}: Wired &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className">) {
  return (
    <textarea
      {...rest}
      id={id}
      className="ui-textarea"
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    />
  );
}

export function Select({
  id,
  describedBy,
  invalid,
  children,
  ...rest
}: Wired & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "className">) {
  return (
    <select
      {...rest}
      id={id}
      className="ui-select"
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    >
      {children}
    </select>
  );
}

/**
 * Casilla. Su etiqueta envuelve al control, así que el área táctil es toda la
 * fila y no solo el cuadrito de 18 px.
 */
export function Checkbox({
  label,
  hint,
  disabled,
  ...rest
}: { label: ReactNode; hint?: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
>) {
  return (
    <label className="ui-check" data-disabled={disabled ? "true" : undefined}>
      <input type="checkbox" disabled={disabled} {...rest} />
      <span>
        <span style={{ fontSize: "var(--text-sm)" }}>{label}</span>
        {hint ? (
          <span className="ui-hint" style={{ display: "block" }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * Resumen de errores al enviar un formulario largo.
 *
 * Va arriba del formulario, recibe el foco al aparecer (`tabIndex={-1}` más un
 * `.focus()` de quien lo monta) y cada línea es un enlace al campo que falla.
 * En la cuenta de servicio, en el celular, la técnica no ve la mitad del
 * formulario: sin esto, "algo falló" la deja buscando a ciegas.
 */
export function FormErrorSummary({
  title = "Revisá estos campos antes de guardar",
  errors,
}: {
  title?: string;
  /** `[idDelCampo, mensaje]`. El id es el mismo que `Field` le pasó al input. */
  errors: ReadonlyArray<{ id: string; message: string }>;
}) {
  if (errors.length === 0) return null;
  return (
    <div
      className="ui-errorsummary"
      role="alert"
      tabIndex={-1}
      aria-labelledby="ui-errsum-title"
    >
      <strong id="ui-errsum-title" style={{ fontSize: "var(--text-sm)" }}>
        {title}
      </strong>
      <ul>
        {errors.map((e) => (
          <li key={e.id}>
            <a href={`#${e.id}`}>{e.message}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
