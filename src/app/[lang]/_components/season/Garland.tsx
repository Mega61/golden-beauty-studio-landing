"use client";

import { useEffect, useRef, useState } from "react";
import Bauble from "./Bauble";

/**
 * Guirnalda de temporada: una cinta dorada de un pelo con dos caídas y cuatro
 * bolas que se mecen. Va encima del separador de marca (`BrandDivider`).
 *
 * El vaivén solo corre mientras la guirnalda está en pantalla — una animación
 * CSS fuera de la vista igual gasta frames en algunos navegadores — y nunca con
 * `prefers-reduced-motion` (eso lo resuelve la hoja de estilos).
 */

const W = 600;
const H = 44;
const TOP = 6;
const SAG = 24;

/** Altura de la cinta en x (0–1): dos caídas iguales, como una guirnalda colgada de tres clavos. */
function ribbonY(x: number) {
  const half = (x % 0.5) / 0.5;
  return TOP + SAG * Math.sin(Math.PI * half);
}

const RIBBON = Array.from({ length: 51 }, (_, i) => {
  const x = i / 50;
  return `${i === 0 ? "M" : "L"}${(x * W).toFixed(1)},${ribbonY(x).toFixed(1)}`;
}).join(" ");

const BAUBLES = [
  { x: 0.16, size: 10, thread: 12, delay: "0s" },
  { x: 0.31, size: 13, thread: 18, delay: "-1.3s" },
  { x: 0.69, size: 12, thread: 15, delay: "-2.4s" },
  { x: 0.84, size: 9, thread: 11, delay: "-0.7s" },
];

export default function Garland({ tone = "light" }: { tone?: "light" | "dark" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setLive(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const stroke = tone === "dark" ? "var(--color-gold-bright)" : "var(--color-gold)";

  return (
    <div
      ref={ref}
      aria-hidden
      className={`gbs-garland relative mx-auto ${live ? "is-live" : ""}`}
      style={{ width: "min(560px, 86vw)", height: H + 30 }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-x-0 top-0 block h-[44px] w-full overflow-visible"
      >
        <path
          d={RIBBON}
          fill="none"
          stroke={stroke}
          strokeWidth={1}
          strokeOpacity={0.7}
          vectorEffect="non-scaling-stroke"
        />
        {/* Los tres "clavos": un punto donde la cinta se apoya. */}
        {[0, 0.5, 1].map((x) => (
          <circle key={x} cx={x * W} cy={TOP} r={2} fill={stroke} />
        ))}
      </svg>
      {BAUBLES.map((b) => (
        <Bauble
          key={b.x}
          size={b.size}
          thread={b.thread}
          className="gbs-swing absolute"
          style={{
            left: `${b.x * 100}%`,
            marginLeft: -b.size / 2,
            top: (ribbonY(b.x) / H) * 44,
            animationDelay: b.delay,
          }}
        />
      ))}
    </div>
  );
}
