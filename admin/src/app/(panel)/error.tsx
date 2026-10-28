"use client";

import { useEffect, useTransition } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { Button, ButtonLink, EmptyState } from "@/components/ui";

/**
 * Una pantalla del panel que falló al cargar.
 *
 * Antes caía a la pantalla de error de Next, sin navegación ni salida: en la
 * app instalada, que no tiene barra del navegador, eso era cerrar y volver a
 * abrir. Ahora el marco sigue ahí —lo pone el layout— y hay dos salidas:
 * reintentar esta misma pantalla, o ir a Hoy.
 *
 * El mensaje no repite el error técnico: lo que sirve en el mostrador es saber
 * que no fue culpa de quien tocó y qué hacer. El `digest` va en letra chica
 * para quien lo tenga que buscar en los logs.
 */
export default function PanelError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const [retrying, startRetry] = useTransition();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AppShell title="Algo falló">
      <EmptyState
        icon="alerta"
        title="Esta pantalla no se pudo cargar"
        body="Puede ser la conexión o la agenda, que no respondió a tiempo. Lo que ya estaba guardado sigue guardado."
        action={
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" }}>
            <Button
              variant="primary"
              icon="deshacer"
              loading={retrying}
              loadingLabel="Reintentando"
              onClick={() => startRetry(() => unstable_retry())}
            >
              Reintentar
            </Button>
            <ButtonLink href="/hoy" variant="secondary" icon="hoy">
              Ir a Hoy
            </ButtonLink>
          </div>
        }
      />
      {error.digest ? (
        <p className="ui-hint" style={{ textAlign: "center" }}>
          Código: {error.digest}
        </p>
      ) : null}
    </AppShell>
  );
}
