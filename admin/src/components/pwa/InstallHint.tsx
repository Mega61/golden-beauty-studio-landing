"use client";

import { useSyncExternalStore } from "react";

import { Button, Icon } from "@/components/ui";

import { INSTALL_HINT_KEY, installHintMode, type InstallHintMode } from "./install-hint";

/**
 * "Instalar en tu celular": una franja pequeña arriba del contenido, una sola
 * vez.
 *
 * En iPhone son instrucciones (Safari no tiene botón de instalar que una
 * página pueda disparar). En Android es el botón de verdad, con el
 * `beforeinstallprompt` que Chrome entrega cuando la app es instalable. En el
 * computador no aparece: el mostrador no necesita un ícono más.
 *
 * Al cerrarla, o al instalar, se anota en `localStorage` y no vuelve. Si el
 * navegador no deja escribir (ventana privada), se cierra igual por esta
 * visita: un aviso que no se puede quitar es peor que uno que reaparece.
 *
 * Se lee con `useSyncExternalStore` y no con estado + efecto: las señales son
 * del navegador (el evento, el disco, el modo de pantalla) y el servidor no
 * tiene ninguna, así que el render del servidor es "nada" y el cliente se
 * engancha sin parpadeo de hidratación.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: BeforeInstallPromptEvent | null = null;
let dismissedThisVisit = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function readDismissed(): boolean {
  if (dismissedThisVisit) return true;
  try {
    return window.localStorage.getItem(INSTALL_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss() {
  dismissedThisVisit = true;
  try {
    window.localStorage.setItem(INSTALL_HINT_KEY, "1");
  } catch {
    // Ver la cabecera: se cierra por esta visita aunque no se pueda recordar.
  }
  emit();
}

// El evento puede llegar antes de que el componente se monte (Chrome lo
// dispara apenas la página es instalable), así que se escucha al cargar el
// módulo y no dentro de un efecto.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Sin esto Chrome muestra su propia barra además de la nuestra.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    dismiss();
  });
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function snapshot(): InstallHintMode {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return installHintMode({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
    mobile: window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches,
    dismissed: readDismissed(),
    hasPrompt: deferred !== null,
  });
}

function serverSnapshot(): InstallHintMode {
  return null;
}

export function InstallHint() {
  const mode = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (mode === null) return null;

  async function install() {
    const prompt = deferred;
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // El evento sirve una sola vez. Si dijo que no, no se insiste.
    deferred = null;
    if (outcome === "dismissed") dismiss();
    else emit();
  }

  return (
    <aside
      aria-label="Instalar el panel"
      style={{
        display: "flex",
        gap: "0.75rem",
        alignItems: "flex-start",
        padding: "0.75rem",
        marginBottom: "1rem",
        borderRadius: "var(--radius-md)",
        background: "var(--color-gold-pale)",
        border: "1px solid var(--color-gold)",
        color: "var(--color-ink)",
      }}
    >
      <Icon name="info" size={18} style={{ flex: "none", marginTop: 2, color: "var(--color-gold-dark)" }} />
      <div style={{ flex: 1, minWidth: 0, fontSize: "var(--text-sm)" }}>
        <strong style={{ display: "block", marginBottom: "0.25rem" }}>
          Instala el panel en tu celular
        </strong>
        {mode === "ios" ? (
          <span>
            En Safari, toca <strong>Compartir</strong> (el cuadro con la flecha hacia arriba) y
            luego <strong>Agregar a inicio</strong>. Queda como una app, a pantalla completa.
          </span>
        ) : (
          <span>Queda como una app: abre más rápido y sin la barra del navegador.</span>
        )}
        {mode === "android" ? (
          <div style={{ marginTop: "0.5rem" }}>
            <Button variant="primary" size="sm" onClick={install}>
              Instalar
            </Button>
          </div>
        ) : null}
      </div>
      <Button variant="ghost" size="sm" icon="cerrar" aria-label="No volver a mostrar" onClick={dismiss} />
    </aside>
  );
}
