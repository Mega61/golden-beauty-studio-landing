"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, Switch, Field, useToast } from "@/components/ui";

import {
  crearClienta,
  editarClienta,
  fusionarClienta,
  marcarCortesiaPorDefecto,
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
        hint="Es la identidad de cada cliente: por acá se sabe que es la misma persona."
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
  const { toast } = useToast();
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null, FormData>(
    async (_previo, formData) => {
      const result = await crearClienta(valoresDe(formData));
      if (result.ok) {
        // El éxito se dice en un aviso, desde acá y no con el estado de la
        // acción: ese estado llega en la misma transición que la revalidación
        // de la lista, y a veces esa transición no se confirmaba — el
        // formulario se cerraba y el "quedó creada" no aparecía nunca. El
        // aviso sale en el acto, con la escritura ya hecha.
        setAbierto(false);
        toast({ message: result.message, tone: "ok" });
      }
      return result;
    },
    initial,
  );

  if (!abierto) {
    return (
      <div>
        <Button type="button" size="sm" onClick={() => setAbierto(true)}>
          Agregar cliente
        </Button>
        {estado?.ok ? null : <Resultado estado={estado} />}
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
  const { toast } = useToast();
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null, FormData>(
    async (_previo, formData) => {
      const result = await editarClienta(eaCustomerId, valoresDe(formData));
      if (result.ok) {
        // El éxito se dice en un aviso, desde acá y no con el estado de la
        // acción: ese estado llega en la misma transición que la revalidación
        // de la lista, y a veces esa transición no se confirmaba — el
        // formulario se cerraba y el "quedó creada" no aparecía nunca. El
        // aviso sale en el acto, con la escritura ya hecha.
        setAbierto(false);
        toast({ message: result.message, tone: "ok" });
      }
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
        {estado?.ok ? null : <Resultado estado={estado} />}
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

/**
 * "Cortesía de la casa por defecto": la casilla de la ficha. Solo se dibuja
 * para la dueña; el permiso lo vuelve a comprobar la Server Action.
 *
 * Es una casilla que se guarda al tocarla, no un formulario con botón: es un
 * sí/no y la respuesta aparece al lado. Se marcan todas las fichas de la
 * persona a la vez.
 */
export function CortesiaPorDefecto({
  eaCustomerIds,
  marcada,
}: {
  eaCustomerIds: number[];
  marcada: boolean;
}) {
  const [valor, setValor] = useState(marcada);
  const [estado, enviar, enviando] = useActionState<ClientActionResult | null, boolean>(
    async (_previo, siguiente) => {
      const result = await marcarCortesiaPorDefecto(eaCustomerIds, siguiente);
      // Si el servidor dijo que no, la casilla vuelve a lo que estaba: una
      // casilla marcada que no quedó guardada es peor que ninguna.
      if (!result.ok) setValor(!siguiente);
      return result;
    },
    initial,
  );

  return (
    <div style={{ display: "grid", gap: "0.125rem" }}>
      <Switch
        label="Cortesía de la casa por defecto"
        hint="Sus cuentas llegan marcadas como cortesía: no se cobran y la profesional cobra su comisión sobre el precio de lista. Se puede desmarcar en cada cuenta."
        checked={valor}
        disabled={enviando}
        onChange={(e) => {
          const siguiente = e.target.checked;
          setValor(siguiente);
          // `startTransition` lo pone `useActionState` cuando la acción se
          // despacha desde un formulario; acá se despacha a mano, así que se
          // envuelve para que `enviando` refleje el envío.
          startTransition(() => enviar(siguiente));
        }}
      />
      <Resultado estado={estado} />
    </div>
  );
}
