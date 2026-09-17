"use client";

import { useActionState, useState } from "react";

import { Button, Field } from "@/components/ui";

import {
  crearClienta,
  editarClienta,
  fusionarClienta,
  type ClientActionResult,
} from "./actions";

/**
 * Los formularios de escritura de Clientas.
 *
 * Son cliente porque necesitan estado de envío y una respuesta en el sitio. Lo
 * que **no** hacen es decidir: el teléfono lo normaliza el servidor, el
 * duplicado lo detecta el servidor, y quién sobrevive en una fusión lo decide
 * `merge.ts`. Acá solo se recogen cadenas.
 *
 * `<form action={…}>` y no `onClick`: el botón queda deshabilitado mientras
 * envía sin cablearlo, y un doble clic no crea dos clientas.
 */

const initial: ClientActionResult | null = null;

function Resultado({ estado }: { estado: ClientActionResult | null }) {
  if (!estado) return null;
  return (
    <p
      role="status"
      style={{
        margin: "0.25rem 0 0",
        fontSize: "var(--text-2xs)",
        color: estado.ok ? "var(--color-ok-ink)" : "var(--color-error-ink)",
      }}
    >
      {estado.message}
    </p>
  );
}

export type ValoresClienta = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string;
};

const VACIA: ValoresClienta = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  notes: "",
};

/**
 * Los cinco campos, compartidos entre crear y editar.
 *
 * El correo no es obligatorio y el formulario lo dice: muchas clientas del
 * estudio no tienen, o dan el del esposo. Dejarlo vacío es la respuesta
 * correcta, no un formulario a medio llenar.
 */
function CamposClienta({ valores, prefijo }: { valores: ValoresClienta; prefijo: string }) {
  return (
    <div style={{ display: "grid", gap: "0.5rem" }} key={prefijo}>
      <Field label="Nombre" required>
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            name="firstName"
            className="ui-input"
            required
            maxLength={120}
            defaultValue={valores.firstName}
          />
        )}
      </Field>

      <Field label="Apellido">
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            name="lastName"
            className="ui-input"
            maxLength={120}
            defaultValue={valores.lastName}
          />
        )}
      </Field>

      <Field
        label="Teléfono"
        required
        hint="Es la identidad de la clienta: por acá se sabe que es la misma persona."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            name="phone"
            className="ui-input"
            required
            inputMode="tel"
            maxLength={30}
            placeholder="300 123 4567"
            defaultValue={valores.phone}
          />
        )}
      </Field>

      <Field
        label="Correo (opcional)"
        hint="Si no tiene, se deja vacío. Un correo inventado rebota y ensucia la ficha para siempre."
      >
        {({ id, describedBy }) => (
          <input
            id={id}
            aria-describedby={describedBy}
            name="email"
            className="ui-input"
            type="email"
            maxLength={200}
            defaultValue={valores.email}
          />
        )}
      </Field>

      <Field label="Notas">
        {({ id, describedBy }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            name="notes"
            className="ui-input"
            rows={2}
            maxLength={2000}
            defaultValue={valores.notes}
          />
        )}
      </Field>
    </div>
  );
}

function valoresDe(formData: FormData): ValoresClienta {
  return {
    firstName: String(formData.get("firstName") ?? ""),
    lastName: String(formData.get("lastName") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  };
}

/** Alta de una clienta que entró caminando. Plegado hasta que se necesita. */
export function NuevaClienta() {
  const [abierto, setAbierto] = useState(false);
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null, FormData>(
    async (_previo, formData) => {
      const result = await crearClienta(valoresDe(formData));
      if (result.ok) setAbierto(false);
      return result;
    },
    initial,
  );

  if (!abierto) {
    return (
      <div>
        <Button type="button" size="sm" onClick={() => setAbierto(true)}>
          Nueva clienta
        </Button>
        <Resultado estado={estado} />
      </div>
    );
  }

  return (
    <form action={enviar} style={{ display: "grid", gap: "0.5rem", maxWidth: "26rem" }}>
      <CamposClienta valores={VACIA} prefijo="nueva" />
      <div style={{ display: "flex", gap: "0.375rem" }}>
        <Button type="submit" variant="primary" size="sm" loading={enviando}>
          Crear
        </Button>
        <Button type="button" size="sm" onClick={() => setAbierto(false)}>
          Cancelar
        </Button>
      </div>
      <Resultado estado={estado} />
    </form>
  );
}

/**
 * Corregir una clienta.
 *
 * Solo se ofrece cuando la ficha viene de **una** fila de EA. Con varias, editar
 * una dejaría a las otras con el dato viejo — que es exactamente cómo se pierde
 * una corrección. Primero se fusiona, después se corrige.
 */
export function EditarClienta({
  eaCustomerId,
  valores,
}: {
  eaCustomerId: number;
  valores: ValoresClienta;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null, FormData>(
    async (_previo, formData) => {
      const result = await editarClienta(eaCustomerId, valoresDe(formData));
      if (result.ok) setAbierto(false);
      return result;
    },
    initial,
  );

  if (!abierto) {
    return (
      <div>
        <Button type="button" size="sm" onClick={() => setAbierto(true)}>
          Corregir datos
        </Button>
        <Resultado estado={estado} />
      </div>
    );
  }

  return (
    <form action={enviar} style={{ display: "grid", gap: "0.5rem", maxWidth: "26rem" }}>
      <CamposClienta valores={valores} prefijo={`editar-${eaCustomerId}`} />
      <div style={{ display: "flex", gap: "0.375rem" }}>
        <Button type="submit" variant="primary" size="sm" loading={enviando}>
          Guardar
        </Button>
        <Button type="button" size="sm" onClick={() => setAbierto(false)}>
          Cancelar
        </Button>
      </div>
      <Resultado estado={estado} />
    </form>
  );
}

/**
 * Unir las fichas duplicadas.
 *
 * Pide confirmación explícita porque **borra filas de EA**, y es la única
 * operación del panel que destruye un registro de la agenda en vez de agregarle
 * uno. La confirmación dice qué se va a borrar, no "¿estás segura?".
 */
export function FusionarClienta({ eaCustomerIds }: { eaCustomerIds: number[] }) {
  const [confirmando, setConfirmando] = useState(false);
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null>(
    () => fusionarClienta(eaCustomerIds),
    initial,
  );

  if (!confirmando) {
    return (
      <div>
        <Button type="button" size="sm" onClick={() => setConfirmando(true)}>
          Unir las {eaCustomerIds.length} fichas
        </Button>
        <Resultado estado={estado} />
      </div>
    );
  }

  return (
    <form action={enviar} style={{ display: "grid", gap: "0.375rem" }}>
      <p style={{ margin: 0, fontSize: "var(--text-2xs)" }}>
        Se queda la ficha <span className="ui-num">#{Math.min(...eaCustomerIds)}</span> —
        la más antigua— y se borran las demás. Antes de borrar nada, sus citas se
        mueven a la que queda y se verifica que llegaron.
      </p>
      <div style={{ display: "flex", gap: "0.375rem" }}>
        <Button type="submit" variant="primary" size="sm" loading={enviando}>
          Unir
        </Button>
        <Button type="button" size="sm" onClick={() => setConfirmando(false)}>
          Cancelar
        </Button>
      </div>
      <Resultado estado={estado} />
    </form>
  );
}
