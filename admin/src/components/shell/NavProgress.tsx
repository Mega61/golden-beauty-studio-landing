"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Lo que dispara quien navega por código (`router.push`), p. ej. `DaySwipe`. */
export const NAV_START_EVENT = "panel:navstart";

/**
 * Una raya dorada arriba de todo mientras se espera la pantalla siguiente.
 *
 * Existe porque Caja, Clientes, Comisiones, Equipo, Reportes y Servicios no
 * pueden tener `loading.tsx` (ver `app/(panel)/loading-boundaries.test.ts`):
 * sin esqueleto, tocar un destino no cambiaba nada hasta que el servidor
 * contestaba. La pastilla de la barra inferior ya se enciende al tocar; esto
 * dice además "está cargando", en cualquier tamaño de pantalla y también para
 * los enlaces de adentro de la pantalla (una fila, una flecha de fecha).
 *
 * Se entera de dos maneras: un clic en un enlace interno que lleva a otra URL
 * (escuchado en captura sobre el documento, sin tocar cada `<Link>`), o el
 * evento `panel:navstart` para la navegación por código. Se apaga cuando la
 * URL cambia. Aparece recién a los 120 ms: una navegación que ya estaba
 * precargada no alcanza a mostrarla, y un parpadeo de raya en cada toque sería
 * ruido. Si en 12 s no llegó nada, se rinde en silencio.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = `${pathname}?${search}`;
  const [startedAt, setStartedAt] = useState<{ from: string } | null>(null);
  const [visible, setVisible] = useState(false);

  // Cuando la URL ya cambió, la navegación terminó: la marca vieja deja de
  // valer sola, comparando contra la URL desde la que se tocó.
  const pending = startedAt !== null && startedAt.from === here;

  useEffect(() => {
    function start() {
      setStartedAt({ from: `${window.location.pathname.replace(/^\/admin/, "") || "/"}?${new URLSearchParams(window.location.search).toString()}` });
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    }

    document.addEventListener("click", onClick, true);
    window.addEventListener(NAV_START_EVENT, start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(NAV_START_EVENT, start);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const show = window.setTimeout(() => setVisible(true), 120);
    const giveUp = window.setTimeout(() => setStartedAt(null), 12_000);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(giveUp);
      setVisible(false);
    };
  }, [pending]);

  return <div className="ui-navprogress" data-active={pending && visible ? "true" : undefined} aria-hidden />;
}
