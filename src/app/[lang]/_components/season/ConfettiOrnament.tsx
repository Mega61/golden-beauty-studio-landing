"use client";

import { useRef } from "react";
import Bauble from "./Bauble";

/**
 * El huevo de pascua del footer: una bola que, al tocarla, suelta una lluvia
 * corta de confeti dorado desde donde está.
 *
 * El canvas se crea al tocar y se borra solo al terminar (~2 s): mientras nadie
 * la toque no hay nada corriendo. Con `prefers-reduced-motion` la bola solo se
 * mece y no hay lluvia.
 */

const PALETTE = ["#ac8231", "#e7aa51", "#ffd49f", "#fff1d6", "#8b6a1f"];
const DURATION_MS = 2200;

function burst(originX: number, originY: number) {
  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "80",
  });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const pieces = Array.from({ length: 90 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 380 + Math.random() * 520;
    return {
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 14,
      flip: Math.random() * Math.PI,
      w: 4 + Math.random() * 5,
      h: 6 + Math.random() * 8,
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
      round: Math.random() < 0.3,
    };
  });

  const t0 = performance.now();
  let last = t0;
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const life = (now - t0) / DURATION_MS;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = life > 0.7 ? Math.max(0, 1 - (life - 0.7) / 0.3) : 1;
    for (const p of pieces) {
      p.vy += 900 * dt; // gravedad
      p.vx *= 1 - 1.6 * dt; // aire
      p.vy *= 1 - 0.9 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.flip += 9 * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (life < 1) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

export default function ConfettiOrnament({ label }: { label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);

  const onClick = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("is-rung");
    // Reinicia la animación del vaivén aunque la toquen dos veces seguidas.
    void el.offsetWidth;
    el.classList.add("is-rung");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (busy.current) return;
    busy.current = true;
    window.setTimeout(() => (busy.current = false), 600);
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height * 0.75);
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="gbs-confetti-ornament relative inline-flex h-12 w-10 cursor-pointer items-start justify-center border-0 bg-transparent p-0"
    >
      <Bauble size={16} thread={20} className="gbs-swing-hover" />
    </button>
  );
}
