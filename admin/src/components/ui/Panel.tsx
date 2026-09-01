"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * El panel: hoja desde abajo en móvil, panel lateral en escritorio. **Un solo
 * componente y un solo elemento.**
 *
 * Es un `<dialog>` nativo abierto con `showModal()`. Esa decisión trae gratis
 * cuatro cosas que a mano cuestan un archivo entero y se rompen en la primera
 * combinación rara: capa superior (nada de `z-index` peleando con la barra
 * pegajosa de la agenda), trampa de foco, cierre con Escape, y el resto de la
 * página inerte para el lector de pantalla. Lo único que cambia entre móvil y
 * escritorio es de dónde entra, y eso es CSS.
 *
 * Lo que sí hay que hacer a mano, y está acá:
 *
 * - **Cerrar al tocar el fondo.** El `::backdrop` no recibe eventos propios: el
 *   clic llega al `<dialog>` con coordenadas fuera de su caja. Se compara
 *   contra el rectángulo del elemento. Sin esto, en móvil la única salida es el
 *   botón, y el gesto de "tocar afuera" —que todo el mundo prueba primero— no
 *   hace nada.
 * - **Devolver el foco.** Al cerrar, el foco vuelve a lo que lo abrió. El
 *   navegador lo hace bien casi siempre, pero no cuando el disparador se
 *   desmontó (una fila que desapareció al guardar), así que se guarda la
 *   referencia.
 * - **Bloquear el scroll de atrás.** `showModal()` no lo hace en iOS.
 *
 * Para el caso de ≥1440 px, donde el plan pide el panel persistente al lado de
 * la agenda, está `PanelInline`: el mismo cromo sin capa modal.
 */
export function Panel({
  open,
  onClose,
  title,
  children,
  footer,
  /** Qué se anuncia en el botón de cerrar. */
  closeLabel = "Cerrar",
  /**
   * Un panel con cambios sin guardar no se cierra tocando el fondo ni con
   * Escape: se pierde el trabajo en un gesto. La cuenta de servicio lo usa.
   */
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open && !el.open) {
      opener.current = (document.activeElement as HTMLElement) ?? null;
      el.showModal();
      document.documentElement.style.overflow = "hidden";
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return () => {
      document.documentElement.style.overflow = "";
      opener.current?.focus?.();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="ui-panel"
      aria-labelledby={titleId}
      onCancel={(e) => {
        // `cancel` es Escape. Con cambios sin guardar se ignora.
        if (!dismissable) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (!dismissable) return;
        const el = ref.current;
        if (!el || e.target !== el) return;
        const r = el.getBoundingClientRect();
        const outside =
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom;
        if (outside) onClose();
      }}
    >
      <header className="ui-panel__head">
        <h2 className="ui-panel__title" id={titleId}>
          {title}
        </h2>
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <Icon name="cerrar" size={18} />
        </button>
      </header>
      <div className="ui-panel__body">{children}</div>
      {footer ? <div className="ui-panel__foot">{footer}</div> : null}
    </dialog>
  );
}

/**
 * La variante persistente de ≥1440 px: ver la cita sin tapar la grilla. Mismo
 * cromo, mismo espaciado, sin capa modal ni trampa de foco — porque acá no hay
 * nada que atrapar: la grilla sigue siendo utilizable al lado.
 */
export function PanelInline({
  title,
  onClose,
  children,
  footer,
  closeLabel = "Cerrar",
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}) {
  const titleId = useId();
  return (
    <aside className="ui-panel ui-panel--inline" aria-labelledby={titleId}>
      <header className="ui-panel__head">
        <h2 className="ui-panel__title" id={titleId}>
          {title}
        </h2>
        {onClose ? (
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--icon ui-btn--sm"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <Icon name="cerrar" size={18} />
          </button>
        ) : null}
      </header>
      <div className="ui-panel__body">{children}</div>
      {footer ? <div className="ui-panel__foot">{footer}</div> : null}
    </aside>
  );
}
