"use client";

import { useEffect } from "react";

import { PANEL_BASE_PATH } from "@/lib/push/config";

/**
 * Registra `/admin/sw.js` con alcance `/admin/`.
 *
 * Vive en el layout raíz para que la app instalada tenga su service worker
 * desde la primera pantalla, incluida la de entrar. El worker no intercepta
 * ninguna petición (ver la cabecera de `public/sw.js`): registrarlo en todas
 * partes no puede servir nada viejo.
 *
 * `updateViaCache: "none"` hace que el navegador pida el `sw.js` a la red en
 * cada chequeo de actualización, en vez de confiar en su caché HTTP: un
 * arreglo al worker llega con la siguiente visita y no días después.
 *
 * Sin `serviceWorker` (navegador viejo, ventana privada de Firefox) no pasa
 * nada: el panel funciona igual, solo sin avisos.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(`${PANEL_BASE_PATH}/sw.js`, {
        scope: `${PANEL_BASE_PATH}/`,
        updateViaCache: "none",
      })
      .catch((error: unknown) => {
        console.warn("[pwa] no se pudo registrar el service worker", error);
      });
  }, []);

  return null;
}
