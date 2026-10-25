"use client";

import { useActionState, useEffect, useState } from "react";

import { Button, Panel, formatCOP, formatDateLong } from "@/components/ui";

import { agregarTardias, cerrarDia, reintentarPush, type CerrarDiaResult, type PushResult } from "./actions";

/**
 * Los botones de Caja.
 *
 * Son cliente porque necesitan estado de envío y una respuesta en el sitio; lo
 * que **no** hacen es decidir nada. La compuerta la vuelve a evaluar el servidor
 * con los datos del momento del clic, y `bloqueado` acá solo apaga el botón:
 * deshabilitar es cortesía con la usuaria, no la compuerta.
 *
 * `<form action={…}>` y no `onClick`: el botón queda deshabilitado mientras
 * envía sin cablearlo, y **un doble clic no cierra el día dos veces**. Aunque lo
 * hiciera, `closeDay()` es idempotente en los dos niveles —la fila `day_close` y
 * el push— así que el peor caso de un doble envío es un mensaje repetido.
 *
 * Nada de `Toast` con Deshacer acá: un cierre diario no se deshace. Congela las
 * cuentas y manda la plata a Actual Budget, que no actualiza montos ya
 * importados; lo que revierte un cierre no es un botón, es un ajuste con su
 * motivo.
 */

function Mensaje({ estado }: { estado: { ok: boolean; message: string } | null }) {
  if (!estado) return null;
  return (
    <p
      role="status"
      style={{
        margin: "0.5rem 0 0",
        fontSize: "var(--text-xs)",
        color: estado.ok ? "var(--color-ok-ink)" : "var(--color-error-ink)",
      }}
    >
      {estado.message}
    </p>
  );
}

/**
 * Cerrar el día.
 *
 * El mensaje junta dos desenlaces que son distintos a propósito: el día pudo
 * cerrarse **y** el push pudo fallar. No es un caso raro que haya que esconder
 * — con el push apagado es el caso normal — y la recepción tiene que ver las dos
 * frases, porque la segunda es la que se arregla con "Reintentar".
 */
export function CierreDelDia({
  fecha,
  bloqueado,
  cuentas,
  totales,
}: {
  fecha: string;
  bloqueado: boolean;
  cuentas: number;
  /** Lo que se va a congelar y mandar, para leerlo antes de confirmar. */
  totales: { efectivo: number; transferencia: number; otro: number; tips: number };
}) {
  const [estado, enviar, enviando] = useActionState<CerrarDiaResult | null>(
    () => cerrarDia(fecha),
    null,
  );
  // El cierre congela las cuentas y manda la plata a Actual, que no deja
  // corregir una cifra ya importada. Se puede cerrar desde el celular, así que
  // un toque no alcanza: el primero abre el resumen y el segundo cierra.
  const [confirmando, setConfirmando] = useState(false);
  useEffect(() => {
    if (estado !== null) setConfirmando(false);
  }, [estado]);

  const mensaje =
    estado === null
      ? null
      : estado.ok
        ? { ok: estado.push.state !== "fallo", message: `${estado.message} ${pushTexto(estado)}` }
        : { ok: false, message: estado.message };

  const etiqueta = `${cuentas} ${cuentas === 1 ? "cuenta" : "cuentas"}`;
  const fila = (label: string, valor: number) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
      <span>{label}</span>
      <strong style={{ fontVariantNumeric: "tabular-nums" }}>{formatCOP(valor)}</strong>
    </div>
  );

  return (
    <>
      <Button
        type="button"
        variant="primary"
        block
        disabled={bloqueado || enviando}
        onClick={() => setConfirmando(true)}
      >
        Cerrar el día ({etiqueta})
      </Button>
      <Mensaje estado={mensaje} />

      <Panel
        open={confirmando}
        onClose={() => {
          if (!enviando) setConfirmando(false);
        }}
        dismissable={!enviando}
        title="¿Cerrar el día?"
        footer={
          <form
            action={enviar}
            style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}
          >
            <Button
              type="button"
              variant="secondary"
              disabled={enviando}
              onClick={() => setConfirmando(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={enviando} loadingLabel="Cerrando el día">
              Sí, cerrar el día
            </Button>
          </form>
        }
      >
        <div style={{ display: "grid", gap: "0.75rem", fontSize: "var(--text-sm)" }}>
          <p style={{ margin: 0 }}>
            <strong>{formatDateLong(`${fecha} 00:00:00`)}</strong> · {etiqueta}
          </p>
          <div style={{ display: "grid", gap: "0.375rem" }}>
            {fila("Efectivo", totales.efectivo)}
            {fila("Transferencia", totales.transferencia)}
            {totales.otro === 0 ? null : fila("Otro", totales.otro)}
            {totales.tips === 0 ? null : fila("Propinas (aparte)", totales.tips)}
          </div>
          <p style={{ margin: 0, color: "var(--color-ink-soft)", fontSize: "var(--text-xs)" }}>
            Al cerrar, estas cuentas quedan congeladas y la plata se manda a Actual Budget. Una
            corrección después del cierre viaja como ajuste aparte, no edita la cifra.
          </p>
        </div>
      </Panel>
    </>
  );
}

function pushTexto(estado: Extract<CerrarDiaResult, { ok: true }>): string {
  switch (estado.push.state) {
    case "hecho":
      return `Se empujaron ${estado.push.sent} movimientos al CRM.`;
    case "ya":
      return "El push ya estaba hecho.";
    case "vacio":
      return "No había movimientos que empujar.";
    case "pendiente":
      return "Otro cierre simultáneo se está encargando del push.";
    case "apagado":
      return "El push al CRM está apagado: el lote quedó pendiente.";
    case "antes-del-corte":
      return `Día anterior al corte (${estado.push.since}): su plata vino de Agenda Pro y no se manda.`;
    case "fallo":
      return estado.push.retryable
        ? `El lote no llegó al CRM: ${estado.push.message}`
        : `El CRM rechazó el lote: ${estado.push.message}`;
  }
}

/**
 * Reintentar el push de un día ya cerrado.
 *
 * Existe porque un push que falló en silencio es exactamente igual a no haber
 * empujado. Reintentar manda el **mismo** lote con los **mismos**
 * `imported_id`, con los que Strapi y Actual Budget deduplican: no hace falta
 * saber si el primer intento llegó, y apretarlo dos veces no agrega nada.
 */
export function ReintentarPush({ fecha }: { fecha: string }) {
  const [estado, enviar, enviando] = useActionState<PushResult | null>(
    () => reintentarPush(fecha),
    null,
  );

  return (
    <form action={enviar}>
      <Button type="submit" loading={enviando} loadingLabel="Empujando el lote">
        Reintentar el push al CRM
      </Button>
      <Mensaje estado={estado} />
    </form>
  );
}

/**
 * Agregar al cierre las cuentas que se cerraron después de él.
 *
 * Congela esas cuentas bajo el cierre del día y las empuja solas: las que ya
 * habían salido no se vuelven a mandar.
 */
export function AgregarTardias({ fecha, cuentas }: { fecha: string; cuentas: number }) {
  const [estado, enviar, enviando] = useActionState<PushResult | null>(
    () => agregarTardias(fecha),
    null,
  );

  return (
    <form action={enviar}>
      <Button type="submit" variant="primary" loading={enviando} loadingLabel="Agregando al cierre">
        Agregar al cierre ({cuentas} {cuentas === 1 ? "cuenta" : "cuentas"})
      </Button>
      <Mensaje estado={estado} />
    </form>
  );
}
