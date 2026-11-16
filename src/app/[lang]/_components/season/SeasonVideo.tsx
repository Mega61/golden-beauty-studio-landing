"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loop de video decorativo (los adornos de oro renderizados en 3D).
 *
 * No baja ni un byte hasta que está cerca de la pantalla: `preload="none"` y
 * las fuentes se montan al entrar en vista. Se pausa al salir. Con
 * `prefers-reduced-motion` se queda en el póster. Si el archivo falta, el
 * video se esconde y queda el fondo del contenedor — nunca un reproductor roto.
 */
export default function SeasonVideo({
  webm,
  mp4,
  poster,
  className = "",
}: {
  webm: string;
  mp4: string;
  poster: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNear(true);
          if (!still) video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(video);
    return () => io.disconnect();
  }, []);

  // Las fuentes llegan después del primer play() del observer; reintenta al montarlas.
  useEffect(() => {
    const video = ref.current;
    if (!near || !video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    video.load();
    video.play().catch(() => {});
  }, [near]);

  if (failed) return null;

  return (
    <video
      ref={ref}
      aria-hidden
      muted
      loop
      playsInline
      preload="none"
      poster={poster}
      onError={() => setFailed(true)}
      className={className}
    >
      {near && (
        <>
          <source src={webm} type="video/webm" />
          <source src={mp4} type="video/mp4" onError={() => setFailed(true)} />
        </>
      )}
    </video>
  );
}
