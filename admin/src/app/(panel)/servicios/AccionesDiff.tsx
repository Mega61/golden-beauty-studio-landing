"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";

import {
  crearServicio,
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
 * Crear en la agenda un servicio que la vitrina tiene y EA no.
 *
 * El nombre es un campo de texto porque **no existe en ninguna fuente que esta
 * app pueda leer**: `pricing.ts` guarda id, precio y duración; los nombres viven
 * en los diccionarios de la landing. Derivarlo del id sería inventar lo que la
 * clienta lee en su confirmación de cita, así que lo escribe quien lo crea. Es
 * una vez por servicio, en toda su vida.
 *
 * El precio y la duración no están en el formulario a propósito: el servidor los
 * relee de la vitrina. Es la misma regla que Publicar.
 */
export function FormCrear({ pricingId }: { pricingId: string }) {
  const [estado, enviar, enviando] = useActionState<ActionResult | null, FormData>(
    (_previo, formData) => crearServicio(pricingId, String(formData.get("name") ?? "")),
    initial,
  );

  return (
    <form action={enviar} style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
      <label className="ui-sr" htmlFor={`crear-${pricingId}`}>
        Nombre con el que {pricingId} aparece en la agenda
      </label>
      <input
        id={`crear-${pricingId}`}
        name="name"
        className="ui-input"
        required
        maxLength={120}
        placeholder="Nombre para la agenda"
        style={{ maxWidth: "14rem" }}
      />
      <Button type="submit" size="sm" loading={enviando}>
        Crear
      </Button>
      <Resultado estado={estado} />
    </form>
  );
}

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
    // Sin servicios libres, vincular no es una opción — pero crear sí, y es el
    // camino normal de un combo. El botón de crear se dibuja aparte, arriba.
    return null;
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
