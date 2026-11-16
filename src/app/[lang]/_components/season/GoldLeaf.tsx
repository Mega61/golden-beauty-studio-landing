"use client";

import { useEffect, useRef } from "react";

/**
 * Pan de oro que cae sobre el hero — la "nieve" de la Navidad Golden.
 *
 * Láminas irregulares que bajan despacio, se mecen y giran sobre sí mismas; al
 * quedar de frente a la luz se aclaran hacia oro pálido, que es el destello.
 *
 * Reglas para que no cueste nada:
 * - Arranca después del evento `load` (y en un momento ocioso), así la foto
 *   del hero sigue siendo el LCP y el canvas no compite con ella.
 * - Se pausa fuera de pantalla (IntersectionObserver) y con la pestaña oculta.
 * - Con `prefers-reduced-motion` no arranca: el hero queda como siempre.
 * - Menos láminas en celular; el canvas es `absolute` y `pointer-events:none`,
 *   no mueve el layout ni tapa los botones.
 */

const COLORS = {
  dark: [139, 106, 31], // gold-dark
  gold: [172, 130, 49], // gold
  bright: [231, 170, 81], // gold-bright
  pale: [255, 241, 214], // gold-pale
} as const;

type Flake = {
  x: number;
  y: number;
  size: number;
  vy: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  rot: number;
  vrot: number;
  flip: number;
  vflip: number;
  alpha: number;
  /** Forma irregular: cuatro radios por lámina, fijos para toda su vida. */
  shape: [number, number, number, number];
};

function lerp(a: readonly number[], b: readonly number[], t: number) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function makeFlake(w: number, h: number, anywhere: boolean): Flake {
  const size = 4 + Math.random() * 7;
  return {
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : -20 - Math.random() * 60,
    size,
    // Las grandes caen un poco más rápido: da profundidad sin desenfoque.
    vy: 10 + size * 1.6 + Math.random() * 6,
    swayAmp: 10 + Math.random() * 26,
    swayFreq: 0.25 + Math.random() * 0.35,
    phase: Math.random() * Math.PI * 2,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.9,
    flip: Math.random() * Math.PI * 2,
    vflip: 1.2 + Math.random() * 1.8,
    alpha: 0.45 + Math.random() * 0.45,
    shape: [
      0.75 + Math.random() * 0.5,
      0.55 + Math.random() * 0.45,
      0.75 + Math.random() * 0.5,
      0.55 + Math.random() * 0.45,
    ],
  };
}

export default function GoldLeaf() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const flakes: Flake[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    let visible = true;
    let started = false;
    let disposed = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = w < 768 ? 16 : 34;
      while (flakes.length < target) flakes.push(makeFlake(w, h, true));
      flakes.length = target;
    };

    const draw = (f: Flake, t: number) => {
      const sway = Math.sin(t * f.swayFreq + f.phase) * f.swayAmp;
      // cos del giro = cuánto de la cara mira a la cámara; de canto casi no se ve.
      const face = Math.cos(f.flip);
      const glint = Math.pow(Math.abs(face), 6);
      const base = face > 0 ? lerp(COLORS.gold, COLORS.bright, 0.5) : COLORS.dark;
      const [r, g, b] = lerp(base, COLORS.pale, glint * 0.85);
      ctx.save();
      ctx.translate(f.x + sway, f.y);
      ctx.rotate(f.rot);
      ctx.scale(1, Math.max(0.12, Math.abs(face)));
      ctx.globalAlpha = f.alpha * (0.55 + 0.45 * Math.abs(face));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const s = f.size;
      const [a, bb, c, d] = f.shape;
      ctx.beginPath();
      ctx.moveTo(s * a, 0);
      ctx.lineTo(0, s * bb * 0.8);
      ctx.lineTo(-s * c, 0);
      ctx.lineTo(0, -s * d * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden || disposed) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      const t = now / 1000;
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < flakes.length; i++) {
        const f = flakes[i];
        f.y += f.vy * dt;
        f.rot += f.vrot * dt;
        f.flip += f.vflip * dt;
        if (f.y > h + 24) flakes[i] = makeFlake(w, h, false);
        draw(flakes[i], t);
      }
      raf = requestAnimationFrame(tick);
    };

    const resume = () => {
      if (!started || raf || disposed) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) resume();
    });
    const ro = new ResizeObserver(resize);
    const onVisibility = () => {
      if (!document.hidden) resume();
    };

    const start = () => {
      if (disposed) return;
      started = true;
      resize();
      ro.observe(canvas);
      io.observe(canvas);
      document.addEventListener("visibilitychange", onVisibility);
      canvas.style.opacity = "1";
      resume();
    };

    // Después de `load` y en un hueco ocioso: la foto del hero manda primero.
    // Safari no tiene requestIdleCallback.
    const idle = () => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, { timeout: 1500 });
      } else {
        setTimeout(start, 200);
      }
    };
    if (document.readyState === "complete") idle();
    else window.addEventListener("load", idle, { once: true });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("load", idle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ opacity: 0, transition: "opacity 1600ms ease" }}
    />
  );
}
