"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui";

import {
  liquidarQuincena,
  marcarPagada,
  marcarRevisada,
  type EstadoResult,
  type LiquidarResult,
} from "./actions";

/**
 * Los botones de Comisiones.
 *
 * Son cliente porque necesitan estado de envío y contestar en el sitio; lo que
 * **no** hacen es decidir nada. Las tres compuertas —el permiso, la revisión
 * completa y la inmutabilidad de lo pagado— se vuelven a evaluar en el servidor
 * con los datos del momento del clic. `disabled` acá es cortesía con la
 * usuaria, no la compuerta.
 *
 * `<form action={…}>` y no `onClick`: el botón queda deshabilitado mientras
 * envía sin cablearlo, y un doble clic no liquida dos veces. Aunque lo hiciera,
 * liquidar es idempotente — las dos UNIQUE del esquema lo garantizan.
 */

function Mensaje({
  estado,
}: {
  estado: { ok: boolean; message: string; detail?: string[]; blockers?: string[] } | null;
}) {
  if (estado === null) return null;
  const extra = estado.detail ?? estado.blockers ?? [];

  return (
    <div
      role="status"
      style={{
        marginTop: "0.5rem",
        fontSize: "var(--text-xs)",
        color: estado.ok ? "var(--color-ok-ink)" : "var(--color-error-ink)",
      }}
    >
      <p style={{ margin: 0 }}>{estado.message}</p>
      {extra.length === 0 ? null : (
        <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.125rem" }}>
          {extra.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Liquidar (o volver a liquidar) la quincena completa.
 *
 * Una sola acción para todas las técnicas: la quincena es la unidad de la
 * liquidación, y calcular "la de Lina" aparte invitaría a que dos técnicas del
 * mismo periodo se hubieran calculado con datos de dos momentos distintos.
 */
export function LiquidarQuincena({
  quincena,
  ya,
}: {
  /** Cualquier día de dentro del periodo. */
  quincena: string;
  /** `true` = ya hay liquidaciones: el botón recalcula en vez de crear. */
  ya: boolean;
}) {
  const [estado, enviar, enviando] = useActionState<LiquidarResult | null>(
    () => liquidarQuincena(quincena),
    null,
  );

  return (
    <form action={enviar}>
      <Button
        type="submit"
        variant="primary"
        icon="comisiones"
        loading={enviando}
        loadingLabel="Calculando la quincena"
      >
        {ya ? "Volver a calcular" : "Calcular la quincena"}
      </Button>
      <Mensaje
        estado={
          estado === null
            ? null
            : estado.ok
              ? { ok: true, message: estado.message, detail: estado.detail }
              : { ok: false, message: estado.message }
        }
      />
    </form>
  );
}

export function MarcarRevisada({
  quincena,
  eaProviderId,
  bloqueado,
}: {
  quincena: string;
  eaProviderId: number;
  bloqueado: boolean;
}) {
  const [estado, enviar, enviando] = useActionState<EstadoResult | null>(
    () => marcarRevisada(quincena, eaProviderId),
    null,
  );

  return (
    <form action={enviar}>
      <Button
        type="submit"
        icon="check"
        loading={enviando}
        loadingLabel="Marcando como revisada"
        disabled={bloqueado}
      >
        Marcar como revisada
      </Button>
      <Mensaje estado={estado} />
    </form>
  );
}

/**
 * Marcar la quincena de una técnica como pagada.
 *
 * **Confirma en el sitio, con la cifra a la vista.** Es la única acción
 * irreversible de la pantalla —después de pagar no se ajusta nada— y un botón
 * de un solo clic al lado de "Volver a calcular" es demasiado fácil de apretar
 * por error. No es un diálogo: un diálogo interrumpe y roba el foco para
 * después mostrar la misma frase. El botón se convierte en la confirmación, con
 * el monto adentro, y "Cancelar" al lado.
 */
export function MarcarPagada({
  quincena,
  eaProviderId,
  monto,
  bloqueado,
}: {
  quincena: string;
  eaProviderId: number;
  /** Ya formateado: el componente no toca plata. */
  monto: string;
  bloqueado: boolean;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [estado, enviar, enviando] = useActionState<EstadoResult | null>(
    () => marcarPagada(quincena, eaProviderId),
    null,
  );

  if (!confirmando) {
    return (
      <div>
        <Button
          type="button"
          variant="primary"
          icon="caja"
          disabled={bloqueado}
          onClick={() => setConfirmando(true)}
        >
          Marcar como pagada
        </Button>
        <Mensaje estado={estado} />
      </div>
    );
  }

  return (
    <form action={enviar} style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      <Button
        type="submit"
        variant="primary"
        loading={enviando}
        loadingLabel="Marcando como pagada"
      >
        Confirmar el pago de {monto}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setConfirmando(false)}>
        Cancelar
      </Button>
      <p
        style={{
          flexBasis: "100%",
          margin: 0,
          fontSize: "var(--text-xs)",
          color: "var(--color-ink-soft)",
        }}
      >
        Después de pagar, esta quincena queda cerrada: no se recalcula y no se ajusta. Una
        corrección posterior entra en la quincena siguiente.
      </p>
      <Mensaje estado={estado} />
    </form>
  );
}
