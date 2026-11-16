"use client";

import { useRef, useState } from "react";
import { goldBurst } from "./confetti";

/**
 * El muñeco de nieve dorado (render 3D de raea, `public/navidad/snowman.webp`)
 * y el huevo de pascua de la temporada: al tocarlo da un brinquito y suelta
 * confeti dorado. Un globito «¡Tócame!» late a su lado hasta el primer toque,
 * para que no quede escondido.
 *
 * En reposo se mece despacio (CSS, solo transform). Con `prefers-reduced-motion`
 * no se mece ni brinca y no hay lluvia: queda el muñeco quieto.
 */
export default function SnowmanConfetti({
  label,
  hint,
  size = 96,
  hintSide = "right",
}: {
  label: string;
  hint: string;
  /** Alto del muñeco en px. */
  size?: number;
  hintSide?: "left" | "right";
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [touched, setTouched] = useState(false);

  const onClick = () => {
    const el = ref.current;
    if (!el) return;
    setTouched(true);
    el.classList.remove("is-hop");
    // Reinicia el brinco aunque lo toquen dos veces seguidas.
    void el.offsetWidth;
    el.classList.add("is-hop");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (busy.current) return;
    busy.current = true;
    window.setTimeout(() => (busy.current = false), 600);
    const r = el.getBoundingClientRect();
    goldBurst(r.left + r.width / 2, r.top + r.height * 0.35);
  };

  // El webp recortado mide 403×480.
  const width = Math.round((size * 403) / 480);

  return (
    <span className="relative inline-flex">
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="gbs-snowman relative inline-flex cursor-pointer border-0 bg-transparent p-0"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 18 KB, ya del tamaño justo; next/image no aporta nada aquí */}
        <img
          src="/navidad/snowman.webp"
          alt=""
          width={width}
          height={size}
          loading="lazy"
          decoding="async"
          className="gbs-snowman-img block select-none"
          draggable={false}
        />
      </button>
      {!touched && (
        <span
          aria-hidden
          className={`gbs-snowman-hint pointer-events-none absolute top-[6%] whitespace-nowrap font-sans text-[10px] font-semibold uppercase tracking-[0.24em] text-gold-dark ${
            hintSide === "right" ? "left-[86%]" : "right-[86%]"
          }`}
        >
          {hint}
        </span>
      )}
    </span>
  );
}
