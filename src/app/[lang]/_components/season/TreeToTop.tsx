"use client";

import { useEffect, useRef, useState } from "react";
import { goldBurst } from "./confetti";

/**
 * El "volver arriba" de la temporada: el árbol dorado (render 3D de raea,
 * `public/navidad/tree.webp`) en lugar del botón redondo.
 *
 * - Aparece con un rebote al pasar ~80 % de la primera pantalla, como el botón normal.
 * - En reposo se mece y la estrella titila; la estrella brilla más mientras más
 *   abajo vas (`--p`, progreso de 0 a 1), como si se fuera cargando.
 * - Al tocarlo despega hacia arriba soltando chispas doradas y la página sube.
 *   Cuando vuelve a hacer falta, aparece de nuevo con su rebote.
 *
 * Con `prefers-reduced-motion` no se mece, no despega y no hay chispas: sube la
 * página (sin suavizado, por la regla global) y listo.
 */
export default function TreeToTop({ label }: { label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      ref.current?.style.setProperty("--p", max > 0 ? Math.min(1, y / max).toFixed(3) : "0");
      const show = y > window.innerHeight * 0.8;
      setVisible(show);
      // Llegó arriba: el árbol queda listo para volver a aparecer con su rebote.
      if (!show) setLaunching(false);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const onClick = () => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!still && ref.current) {
      const r = ref.current.getBoundingClientRect();
      goldBurst(r.left + r.width / 2, r.top + r.height * 0.2);
      setLaunching(true);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const state = launching ? "is-launching" : visible ? "is-in" : "";

  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      tabIndex={visible ? 0 : -1}
      className={`gbs-tree-top fixed right-3 z-50 cursor-pointer border-0 bg-transparent p-0 lg:right-5 ${state}`}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 78px)" }}
    >
      <span aria-hidden className="gbs-tree-top-glow" />
      <span className="gbs-tree-top-body block">
        {/* eslint-disable-next-line @next/next/no-img-element -- 15 KB, mismo archivo que la escena del bio */}
        <img
          src="/navidad/tree.webp"
          alt=""
          width={38}
          height={76}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="block select-none"
        />
      </span>
      <span aria-hidden className="gbs-tree-top-star" />
      {/* Flechita de "arriba" que sube por el tronco al pasar el mouse. */}
      <span aria-hidden className="gbs-tree-top-arrow">↑</span>
    </button>
  );
}
