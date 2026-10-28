"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { Icon } from "../ui/Icon";

/**
 * Tirar hacia abajo para actualizar, en el celular.
 *
 * La app instalada no tiene barra del navegador ni botón de recargar, y
 * Chrome apaga su propio "tirar para actualizar" en modo `standalone`. En el
 * mostrador eso es concreto: otra persona agendó una cita y Hoy no la muestra
 * hasta cerrar y volver a abrir la app.
 *
 * Esto hace `router.refresh()`, que vuelve a pedir los datos al servidor sin
 * perder lo que vive en el cliente (una hoja abierta, un borrador). No es una
 * recarga de la página.
 *
 * Reglas del gesto:
 *
 * - Solo arranca con la página arriba del todo y el dedo **fuera** de algo que
 *   scrollea por su cuenta (la grilla de la agenda, el cuerpo de una hoja, una
 *   lista con scroll). Si ese contenedor no está en su tope, el gesto es suyo.
 * - Sigue al dedo con resistencia y avisa con el ícono girando cuando ya se
 *   puede soltar. Por debajo del umbral, soltar no hace nada.
 * - Con una hoja abierta (`<dialog open>`) no existe: la hoja es modal.
 *
 * Para que no haya dos gestos peleando, el de los navegadores en pestaña se
 * apaga en CSS (`overscroll-behavior-y: none` en `<html>`): un solo
 * comportamiento, en pestaña y en la app instalada.
 */

/** Cuánto hay que tirar (ya con la resistencia aplicada) para que suelte. */
const THRESHOLD = 64;
const MAX = 112;

export function PullToRefresh() {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [pull, setPull] = useState(0);
  const g = useRef<{ y0: number; x0: number; active: boolean; pull: number } | null>(null);

  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    // Algo entre el dedo y la página que ya bajó por su cuenta: el gesto es
    // de ese contenedor (volver a su tope), no de la página.
    function insideScrolled(target: EventTarget | null): boolean {
      for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
        if (el.scrollTop > 0) return true;
      }
      return false;
    }

    function onStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      if (window.scrollY > 0 || document.querySelector("dialog[open]")) return;
      if (insideScrolled(e.target)) return;
      const t = e.touches[0];
      g.current = { y0: t.clientY, x0: t.clientX, active: false, pull: 0 };
    }

    function onMove(e: TouchEvent) {
      const s = g.current;
      if (!s) return;
      const t = e.touches[0];
      const dy = t.clientY - s.y0;
      const dx = t.clientX - s.x0;
      if (!s.active) {
        // Hacia arriba, o de lado: no es este gesto.
        if (dy < 0 || Math.abs(dx) > 12) {
          g.current = null;
          return;
        }
        if (dy < 8) return;
        s.active = true;
      }
      // La mitad de lo que se mueve el dedo, con tope: cuesta tirar.
      s.pull = Math.min(MAX, Math.max(0, dy - 8) * 0.5);
      setPull(s.pull);
    }

    function onEnd() {
      const s = g.current;
      g.current = null;
      if (!s?.active) return;
      setPull(0);
      if (s.pull >= THRESHOLD) startRefresh(() => router.refresh());
    }

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [router]);

  const ready = pull >= THRESHOLD;
  const shown = refreshing || pull > 0;

  return (
    <div
      className="ui-ptr"
      data-shown={shown ? "true" : undefined}
      data-ready={ready ? "true" : undefined}
      data-refreshing={refreshing ? "true" : undefined}
      style={{ "--ptr": `${refreshing ? 56 : pull}px`, "--ptr-turn": `${pull * 3}deg` } as CSSProperties}
      role="status"
      aria-live="polite"
    >
      <span className="ui-ptr__puck" aria-hidden>
        {refreshing ? <span className="ui-spinner" /> : <Icon name="actualizar" size={18} />}
      </span>
      <span className="ui-sr">{refreshing ? "Actualizando" : ""}</span>
    </div>
  );
}
