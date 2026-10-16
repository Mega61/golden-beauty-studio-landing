"use client";

import Form from "next/form";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/**
 * El buscador de clientas: busca mientras se escribe.
 *
 * Sigue siendo la URL la que manda (`?q=`), igual que antes: el resultado es
 * compartible, sobrevive a recargar y el Server Component es quien consulta.
 * Lo único que cambia es quién empuja la URL — una pausa de 300 ms al teclear
 * en vez del botón — y que se reemplaza en vez de apilarse, para que "atrás"
 * no recorra letra por letra. Sin JavaScript, el `<Form>` sigue funcionando
 * con Enter.
 */
const DEBOUNCE_MS = 300;

export function BuscadorClientas({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const last = useRef(initial);

  useEffect(() => {
    const term = value.trim();
    if (term === last.current) return;
    const timer = window.setTimeout(() => {
      last.current = term;
      // Cambiar el término vuelve a la página 1: la 3 de otra búsqueda no existe.
      const href = term === "" ? "/clientes" : `/clientes?q=${encodeURIComponent(term)}`;
      startTransition(() => router.replace(href, { scroll: false }));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value, router]);

  return (
    <Form action="/clientes" style={{ display: "flex", gap: "0.5rem", flex: 1, minWidth: 0 }}>
      <label className="ui-sr" htmlFor="q">
        Buscar clienta por nombre, teléfono o correo
      </label>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <input
          id="q"
          name="q"
          type="search"
          className="ui-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Buscar por nombre, teléfono o correo"
          autoComplete="off"
          enterKeyHint="search"
          style={{ width: "100%" }}
        />
        {pending ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: "0.75rem",
              top: "50%",
              width: "0.875rem",
              height: "0.875rem",
              marginTop: "-0.4375rem",
              borderRadius: "50%",
              border: "2px solid var(--hair)",
              borderTopColor: "var(--color-ink-soft)",
              animation: "ui-spin 0.7s linear infinite",
            }}
          />
        ) : null}
      </div>
    </Form>
  );
}
