"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";

import {
  desvincularServicio,
  publicarPrecio,
  publicarTodo,
  vincularServicio,
  type ActionResult,
} from "./actions";

/**
 * Los botones de la pantalla de Servicios.
 *
 * Son cliente porque necesitan estado de envío y una respuesta en el sitio; lo
 * que **no** hacen es decidir nada. Cada uno manda un id y el servidor
 * recalcula el precio leyendo la vitrina de nuevo (ver `actions.ts`): si el
 * monto viajara en el formulario, cualquiera con la consola abierta publicaría
 * el número que quisiera en el catálogo con el que se cobra.
 *
 * `<form action={…}>` y no `onClick`: el botón queda deshabilitado mientras
 * envía sin que haya que cablearlo, y un doble clic no publica dos veces.
 */

const initial: ActionResult | null = null;

function Resultado({ estado }: { estado: ActionResult | null }) {
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

export function BotonPublicar({ pricingId }: { pricingId: string }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null>(
    () => publicarPrecio(pricingId),
    initial,
  );

  return (
    <form action={enviar}>
      <Button type="submit" variant="primary" size="sm" loading={enviando}>
        Publicar
      </Button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonPublicarTodo({ cantidad }: { cantidad: number }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null>(
    () => publicarTodo(),
    initial,
  );

  return (
    <form action={enviar}>
      <Button
        type="submit"
        variant="primary"
        loading={enviando}
        loadingLabel="Publicando el catálogo"
        disabled={cantidad === 0}
      >
        Publicar los {cantidad} desincronizados
      </Button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonDesvincular({ pricingId }: { pricingId: string }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null>(
    () => desvincularServicio(pricingId),
    initial,
  );

  return (
    <form action={enviar}>
      <Button type="submit" size="sm" loading={enviando}>
        Desvincular
      </Button>
      <Resultado estado={estado} />
    </form>
  );
}

export type OpcionServicio = { id: number; label: string };

/**
 * Vincular un id de la vitrina con un servicio que ya existe en EA.
 *
 * El desplegable solo trae los servicios **libres**: el mapa es uno a uno en
 * los dos sentidos (`uq_service_map_ea`), y ofrecer uno ya tomado sería ofrecer
 * un error que la base va a rechazar.
 */
export function FormVincular({
  pricingId,
  opciones,
}: {
  pricingId: string;
  opciones: readonly OpcionServicio[];
}) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null, FormData>(
    (_previo, formData) =>
      vincularServicio(pricingId, Number(formData.get("eaServiceId"))),
    initial,
  );

  if (opciones.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
        No hay servicios libres en la agenda. Hay que crearlo allá primero.
      </p>
    );
  }

  return (
    <form action={enviar} style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
      <label className="ui-sr" htmlFor={`vincular-${pricingId}`}>
        Servicio de la agenda para {pricingId}
      </label>
      <select
        id={`vincular-${pricingId}`}
        name="eaServiceId"
        className="ui-select"
        defaultValue=""
        required
        style={{ maxWidth: "14rem" }}
      >
        <option value="" disabled>
          Elegir…
        </option>
        {opciones.map((opcion) => (
          <option key={opcion.id} value={opcion.id}>
            {opcion.label}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" loading={enviando}>
        Vincular
      </Button>
      <Resultado estado={estado} />
    </form>
  );
}
