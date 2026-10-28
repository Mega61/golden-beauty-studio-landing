"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Panel } from "./Panel";

/**
 * La confirmación del panel, en una hoja y no en `window.confirm()`.
 *
 * Quedan muy pocas acciones que confirman —toda acción destructiva ofrece
 * Deshacer en el toast—: cancelar una cita (avisa a la clienta, y un aviso no
 * se deshace) y marcar una inasistencia (cuenta en la tasa del estudio). Para
 * esas, el diálogo del navegador era el momento más ajeno del panel: una caja
 * gris con "localhost dice…", botones del sistema en inglés en algunos
 * teléfonos, y en la app instalada, el nombre del dominio arriba.
 *
 * La hoja dice qué pasa y deja **la acción con su nombre** en el botón
 * ("Cancelar la cita", no "Aceptar"). El botón de salir dice "Volver", nunca
 * "Cancelar": en la hoja de cancelar una cita, un "Cancelar" que no cancela es
 * una trampa.
 *
 * ```ts
 * const confirm = useConfirm();
 * if (!(await confirm({ title: "¿Cancelar la cita?", confirmLabel: "Cancelar la cita", tone: "danger" }))) return;
 * ```
 *
 * Se monta una vez, en el layout raíz, junto al de los toasts.
 */

export type ConfirmInput = {
  title: string;
  body?: string;
  /** El nombre de la acción. Nunca "Aceptar". */
  confirmLabel: string;
  /** Por defecto "Volver". */
  cancelLabel?: string;
  /** `danger` para lo que no tiene vuelta. */
  tone?: "primary" | "danger";
};

const Ctx = createContext<((c: ConfirmInput) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // El texto no se borra al cerrar: se queda mientras la hoja baja, y la
  // próxima confirmación lo reemplaza.
  const [shown, setShown] = useState<ConfirmInput | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const api = useCallback(
    (c: ConfirmInput) =>
      new Promise<boolean>((resolve) => {
        // Una confirmación nueva sobre otra abierta cuenta como "no" para la
        // de antes: nunca quedan dos promesas colgando.
        resolver.current?.(false);
        resolver.current = resolve;
        setShown(c);
        setOpen(true);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <Panel
        open={open}
        onClose={() => settle(false)}
        title={shown?.title ?? ""}
        fit="content"
        footer={
          <>
            <Button variant="secondary" onClick={() => settle(false)}>
              {shown?.cancelLabel ?? "Volver"}
            </Button>
            <Button
              variant={shown?.tone === "danger" ? "danger" : "primary"}
              onClick={() => settle(true)}
              autoFocus
            >
              {shown?.confirmLabel}
            </Button>
          </>
        }
      >
        {shown?.body ? <p className="ui-confirm__body">{shown.body}</p> : null}
      </Panel>
    </Ctx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm necesita un <ConfirmProvider> arriba en el árbol.");
  return ctx;
}
