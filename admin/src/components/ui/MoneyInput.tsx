"use client";

import { useId, useState } from "react";
import { formatPesos, parsePesos } from "./format";
import { Icon } from "./Icon";

/**
 * Entrada de dinero en pesos colombianos.
 *
 * Lo que hace, y por qué cada cosa:
 *
 * - **Trabaja en enteros.** El valor que sale es un número de pesos; no existe
 *   la fracción de peso ni en pantalla ni en el redondeo de comisiones. Todo lo
 *   que la usuaria escriba que no sea un dígito se descarta al vuelo, así que
 *   pegar `"$ 120.000"` desde WhatsApp funciona.
 * - **Formatea mientras se escribe**, con puntos de mil: `120000` se ve
 *   `120.000`. En un celular, a media luz, entre dos clientas, un número sin
 *   separadores se equivoca por un cero y nadie lo nota hasta el cierre.
 * - **`inputMode="numeric"`** abre el teclado de números en el celular, pero el
 *   `type` sigue siendo `text`: con `type="number"` el navegador acepta `e`,
 *   `+` y `-`, muestra flechitas que nadie quiere en un total, y la rueda del
 *   mouse cambia el monto sin que la usuaria toque nada.
 * - **El signo `$` vive fuera del campo.** Adentro estorba al seleccionar todo
 *   para reemplazar, que es el gesto normal cuando hay que corregir un total.
 *
 * No calcula nada. Ninguna operación de plata ocurre dentro de un componente;
 * eso es de `lib/` y va testeado aparte.
 */
export function MoneyInput({
  label,
  value,
  onValueChange,
  hint,
  error,
  required = false,
  disabled = false,
  name,
  max,
  placeholder = "0",
}: {
  label: string;
  /** Pesos enteros, o `null` si el campo está vacío. */
  value: number | null;
  onValueChange: (pesos: number | null) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  /** Tope duro. Un total de nueve cifras casi siempre es un dedo pegado. */
  max?: number;
  placeholder?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  // Se guarda el texto crudo para que borrar hasta dejarlo vacío no reponga un
  // "0" que después hay que borrar otra vez.
  const [raw, setRaw] = useState<string | null>(null);
  const shown = raw ?? (value === null ? "" : formatPesos(value));

  function handle(next: string) {
    const parsed = parsePesos(next);
    if (parsed !== null && max !== undefined && parsed > max) {
      // Se ignora la tecla en vez de recortar el número: recortar en silencio
      // deja un monto plausible y equivocado, que es el peor resultado posible.
      return;
    }
    setRaw(parsed === null ? "" : formatPesos(parsed));
    onValueChange(parsed);
  }

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

      <div
        className="ui-money"
        data-invalid={error ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
      >
        <span className="ui-money__sign" aria-hidden>
          $
        </span>
        <input
          id={id}
          name={name}
          className="ui-money__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(e) => handle(e.target.value)}
          onBlur={() => setRaw(null)}
        />
      </div>

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
