"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui";

import { sincronizarAhora, type SyncResult } from "./actions";

/**
 * El botón de Caja.
 *
 * Es cliente porque necesita estado de envío y una respuesta en el sitio; lo
 * que **no** hace es decidir nada: la sincronización la resuelve el servidor
 * con los datos del momento del clic.
 *
 * Sin confirmación: no congela nada ni cierra nada. Manda a Actual lo que ya
 * está cobrado —lo mismo que va a pasar solo esta noche— y una cuenta que se
 * corrija después viaja como ajuste. Apretarlo dos veces no manda nada dos
 * veces.
 */
export function SincronizarAhora({ fecha, cuentas }: { fecha: string; cuentas: number }) {
  const [estado, enviar, enviando] = useActionState<SyncResult | null>(
    () => sincronizarAhora(fecha),
    null,
  );

  return (
    <form action={enviar}>
      <Button type="submit" variant="secondary" loading={enviando} loadingLabel="Sincronizando">
        Sincronizar ahora ({cuentas} {cuentas === 1 ? "cuenta" : "cuentas"})
      </Button>
      {estado === null ? null : (
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
      )}
    </form>
  );
}
