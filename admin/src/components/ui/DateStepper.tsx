"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Moverse en el tiempo: día anterior, el día que se está viendo, día
 * siguiente, y volver a hoy.
 *
 * Reemplaza a los "← Día anterior" en letra de 12 px que tenían Hoy, Caja y
 * Comisiones. Eran enlaces de texto en una pantalla que se usa con el pulgar:
 * 90 × 16 px de área, sin forma de botón, y la fecha que se estaba viendo
 * escrita aparte, en mayúsculas chicas, como si no tuviera que ver.
 *
 * Sigue siendo **navegación y no estado**: cada flecha es un `<Link>` a la URL
 * de ese día, así la pantalla sigue siendo un Server Component, el día se
 * puede compartir, y Atrás del celular hace lo que se espera. Lo que agrega:
 *
 * - **La dirección se ve.** Cada enlace lleva `transitionTypes`
 *   (`nav-back` / `nav-forward`), y el `<ViewTransition>` de `AppShell` hace
 *   entrar el día nuevo desde el lado hacia el que se fue, como pasar una hoja.
 * - **Una flecha que no lleva a ningún lado se ve apagada** y no es un enlace
 *   (el futuro en Hoy, por ejemplo): ocupar el lugar y no responder es mejor
 *   que desaparecer y correr la fecha de sitio.
 * - **"Hoy" aparece solo cuando no se está en hoy.**
 */
export type StepperProps = {
  /** El periodo que se ve, dicho como se diría: "Lunes 26 de octubre". */
  label: string;
  /** Una segunda línea corta: "Ayer", "En curso", "Tus citas". */
  sub?: ReactNode;
  prevHref: string | null;
  nextHref: string | null;
  /** `null` cuando ya se está en hoy. */
  todayHref: string | null;
  prevLabel?: string;
  nextLabel?: string;
  todayLabel?: string;
};

export function DateStepper({
  label,
  sub,
  prevHref,
  nextHref,
  todayHref,
  prevLabel = "Día anterior",
  nextLabel = "Día siguiente",
  todayLabel = "Hoy",
}: StepperProps) {
  return (
    <nav className="ui-stepper" aria-label="Cambiar de fecha">
      <StepLink href={prevHref} label={prevLabel} dir="back" />
      <div className="ui-stepper__label" aria-live="polite">
        <span className="ui-stepper__title">{label}</span>
        {sub ? <span className="ui-stepper__sub">{sub}</span> : null}
      </div>
      <StepLink href={nextHref} label={nextLabel} dir="forward" />
      {todayHref ? (
        <Link
          href={todayHref}
          className="ui-btn ui-btn--secondary ui-stepper__today"
          // Hoy siempre queda adelante de un día pasado.
          transitionTypes={["nav-forward"]}
        >
          {todayLabel}
        </Link>
      ) : null}
    </nav>
  );
}

function StepLink({
  href,
  label,
  dir,
}: {
  href: string | null;
  label: string;
  dir: "back" | "forward";
}) {
  const icon = dir === "back" ? "chevron-izq" : "chevron-der";
  if (!href) {
    return (
      <span
        className="ui-btn ui-btn--secondary ui-btn--icon ui-stepper__arrow"
        aria-disabled="true"
        title={label}
      >
        <Icon name={icon} size={20} />
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="ui-btn ui-btn--secondary ui-btn--icon ui-stepper__arrow"
      aria-label={label}
      title={label}
      transitionTypes={[dir === "back" ? "nav-back" : "nav-forward"]}
    >
      <Icon name={icon} size={20} />
    </Link>
  );
}

/**
 * Deslizar de lado para cambiar de día, sobre el contenido de la pantalla.
 *
 * El contenido sigue al dedo con resistencia (un tercio del recorrido) para
 * que se note que el gesto existe; al soltar pasado el umbral navega con la
 * misma dirección de transición que las flechas. Solo cuenta un gesto
 * claramente horizontal: con `touch-action: pan-y` el scroll vertical sigue
 * siendo del navegador, y un dedo que baja en diagonal no cambia de día.
 *
 * No se usa sobre la grilla de la agenda: ahí deslizar de lado es scroll.
 */
export function DaySwipe({
  prevHref,
  nextHref,
  children,
}: {
  prevHref: string | null;
  nextHref: string | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const g = useRef<{ id: number; x0: number; y0: number; dx: number; locked: boolean | null } | null>(
    null,
  );
  // Un deslizamiento que empezó sobre un botón no tiene que terminar
  // apretándolo: con `pan-y`, el navegador no lo trata como scroll y el
  // `click` llegaría igual al soltar.
  const swallowClick = useRef(false);

  // El `transform` existe solo mientras hay gesto o vuelta a su sitio: uno
  // permanente convertiría a este `div` en el bloque contenedor de cualquier
  // `position: fixed` de adentro.
  function reset() {
    const el = ref.current;
    if (!el || el.dataset.swiping !== "true") return;
    delete el.dataset.swiping;
    el.dataset.settling = "true";
    el.style.removeProperty("--day-dx");
    window.setTimeout(() => delete el.dataset.settling, 260);
  }

  return (
    <div
      ref={ref}
      className="ui-dayswipe"
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        swallowClick.current = false;
        if (e.pointerType === "mouse") return;
        if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-swipe]")) return;
        g.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, locked: null };
      }}
      onPointerMove={(e) => {
        const s = g.current;
        const el = ref.current;
        if (!s || !el || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x0;
        const dy = e.clientY - s.y0;
        if (s.locked === null && Math.hypot(dx, dy) > 10) {
          // Se decide una vez: horizontal si el dedo va claramente de lado.
          s.locked = Math.abs(dx) > Math.abs(dy) * 1.5;
        }
        if (!s.locked) return;
        // Hacia un lado sin destino, el contenido apenas se mueve: dice "no
        // hay más" sin ignorar el gesto.
        const allowed = dx > 0 ? prevHref : nextHref;
        s.dx = dx;
        el.dataset.swiping = "true";
        el.style.setProperty("--day-dx", `${(allowed ? dx / 3 : dx / 10).toFixed(1)}px`);
      }}
      onPointerUp={(e) => {
        const s = g.current;
        g.current = null;
        if (!s || s.id !== e.pointerId) return;
        reset();
        if (s.locked && Math.abs(s.dx) > 10) swallowClick.current = true;
        if (!s.locked || Math.abs(s.dx) < 72) return;
        const href = s.dx > 0 ? prevHref : nextHref;
        if (!href) return;
        router.push(href, { transitionTypes: [s.dx > 0 ? "nav-back" : "nav-forward"] });
      }}
      onPointerCancel={() => {
        g.current = null;
        reset();
      }}
    >
      {children}
    </div>
  );
}
