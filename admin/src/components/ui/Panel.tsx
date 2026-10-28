"use client";

import {
  useEffect,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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
 * - **Arrastrar para cerrar** (solo la hoja del celular). Desde la manija o la
 *   cabecera: la hoja sigue al dedo, el fondo se aclara a la par, y al soltar
 *   cierra si bajó más de un cuarto de su alto o si se soltó con velocidad
 *   (un "sacudón" corto cierra aunque haya bajado poco). Si no, vuelve a su
 *   sitio. Una hoja con `dismissable={false}` se deja estirar con
 *   resistencia y siempre vuelve: el gesto se reconoce, pero no tira trabajo.
 *   El arrastre escribe `--drag` en el elemento y apaga la transición; al
 *   soltar, la transición de CSS hace el resto (cerrar o volver).
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
  /**
   * `content`: la hoja mide lo que trae (un menú, una confirmación) en vez de
   * subir casi hasta arriba. Una hoja alta con cuatro renglones arriba y un
   * hueco vacío abajo es una hoja que no sabe qué es.
   */
  fit = "full",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  dismissable?: boolean;
  fit?: "full" | "content";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const drag = useRef<{ id: number; y0: number; t0: number; dy: number } | null>(null);

  function onDragStart(e: ReactPointerEvent<HTMLElement>) {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    // Solo la hoja: en escritorio el panel es lateral y no se arrastra.
    if (!window.matchMedia("(max-width: 47.999rem)").matches) return;
    // Un toque en el botón de cerrar es un toque, no un arrastre.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    drag.current = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    el.dataset.dragging = "true";
  }

  function onDragMove(e: ReactPointerEvent<HTMLElement>) {
    const el = ref.current;
    const d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    const raw = e.clientY - d.y0;
    // Hacia arriba no se va (la hoja ya está entera); sin permiso de cerrar,
    // baja con resistencia: un tercio de lo que se movió el dedo.
    const dy = Math.max(0, dismissable ? raw : raw / 3);
    d.dy = dy;
    el.style.setProperty("--drag", `${dy}px`);
    el.style.setProperty("--backdrop-o", String(Math.max(0.25, 1 - dy / el.offsetHeight)));
  }

  function onDragEnd(e: ReactPointerEvent<HTMLElement>) {
    const el = ref.current;
    const d = drag.current;
    if (!el || !d || d.id !== e.pointerId) return;
    drag.current = null;
    const velocity = d.dy / Math.max(1, performance.now() - d.t0); // px/ms
    delete el.dataset.dragging;
    const close = dismissable && (d.dy > el.offsetHeight * 0.25 || (velocity > 0.6 && d.dy > 24));
    if (close) {
      // `--drag` se queda hasta que la hoja se cierra: la salida arranca desde
      // donde la dejó el dedo, no desde arriba.
      onClose();
    } else {
      el.style.removeProperty("--drag");
      el.style.removeProperty("--backdrop-o");
    }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (open && !el.open) {
      opener.current = (document.activeElement as HTMLElement) ?? null;
      el.showModal();
      document.documentElement.style.overflow = "hidden";
    } else if (!open && el.open) {
      el.close();
      // Para la próxima vez que abra: que entre desde abajo, no desde donde
      // quedó el arrastre. Después de la salida, que dura `--dur-2`.
      const t = window.setTimeout(() => {
        el.style.removeProperty("--drag");
        el.style.removeProperty("--backdrop-o");
      }, 220);
      return () => window.clearTimeout(t);
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
      className={fit === "content" ? "ui-panel ui-panel--fit" : "ui-panel"}
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
      {/* La manija y la cabecera son la zona de arrastre. El cuerpo no: ahí
          el dedo hace scroll. */}
      <div
        className="ui-panel__grip"
        aria-hidden
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      />
      <header
        className="ui-panel__head"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <h2 className="ui-panel__title" id={titleId}>
          {title}
        </h2>
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--icon"
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
            className="ui-btn ui-btn--ghost ui-btn--icon"
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
