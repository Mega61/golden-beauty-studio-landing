"use client";

import { useEffect, useState } from "react";

import { Button, Checkbox, useToast } from "@/components/ui";
import { isIos } from "@/components/pwa/install-hint";
import { PANEL_BASE_PATH } from "@/lib/push/config";

import type { PushActionResult } from "./actions";

/**
 * El interruptor "Avisarme cuando alguien reserve en la página", **para este
 * dispositivo**.
 *
 * El estado verdadero lo tiene el navegador (`pushManager.getSubscription()`),
 * no la base: el mismo usuario puede tenerlo prendido en el celular y apagado
 * en el computador del estudio. Al abrir la pantalla, si el navegador tiene
 * una suscripción se le vuelve a mandar al servidor — por si la podaron o
 * cambió de dueña — y eso es idempotente.
 *
 * Sigue la guía de PWA de Next (`docs/01-app/02-guides/progressive-web-apps.md`),
 * con dos diferencias: la llave pública llega como prop desde el servidor (no
 * `NEXT_PUBLIC_*`, ver `lib/push/config.ts`) y el worker ya lo registra el
 * layout raíz.
 */

type State =
  | "cargando"
  | "sin-soporte"
  /** iPhone en Safari: iOS solo da push a la app instalada. */
  | "instalar-ios"
  | "bloqueado"
  | "apagado"
  | "prendido";

/** De la guía de Next: la llave VAPID en base64url → bytes. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // `register` es idempotente con la misma URL y alcance; llamarlo acá cubre
  // el caso en que el registro del layout todavía no terminó.
  await navigator.serviceWorker.register(`${PANEL_BASE_PATH}/sw.js`, {
    scope: `${PANEL_BASE_PATH}/`,
    updateViaCache: "none",
  });
  return navigator.serviceWorker.ready;
}

function standalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function PushToggle({
  vapidPublicKey,
  onlyOwn = false,
  activate,
  deactivate,
  test,
}: {
  vapidPublicKey: string;
  /** La técnica: solo le llegan las citas de su columna. Cambia el texto. */
  onlyOwn?: boolean;
  activate: (sub: unknown) => Promise<PushActionResult>;
  deactivate: (input: { endpoint: string }) => Promise<PushActionResult>;
  test: (input: { endpoint: string }) => Promise<PushActionResult>;
}) {
  const { toast } = useToast();
  const [state, setState] = useState<State>("cargando");
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported =
        "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      let next: State;
      let ep: string | null = null;
      if (!supported) {
        next = isIos(navigator.userAgent, navigator.maxTouchPoints ?? 0) && !standalone()
          ? "instalar-ios"
          : "sin-soporte";
      } else {
        const reg = await registration();
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          ep = sub.endpoint;
          next = "prendido";
          // Re-sincroniza en silencio. Si falla, la pantalla igual dice la
          // verdad del navegador; el siguiente intento lo arregla.
          void activate(sub.toJSON());
        } else {
          next = Notification.permission === "denied" ? "bloqueado" : "apagado";
        }
      }
      if (!cancelled) {
        setEndpoint(ep);
        setState(next);
      }
    })().catch((error: unknown) => {
      console.warn("[ajustes] no se pudo leer el estado de los avisos", error);
      if (!cancelled) setState("sin-soporte");
    });
    return () => {
      cancelled = true;
    };
  }, [activate]);

  async function turnOn() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState(permission === "denied" ? "bloqueado" : "apagado");
      return;
    }
    const reg = await registration();
    // Una suscripción vieja con otra llave VAPID hace fallar `subscribe`.
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    const result = await activate(sub.toJSON());
    if (!result.ok) {
      // Sin la fila en el servidor, la suscripción del navegador no sirve:
      // se deshace para que el interruptor no mienta.
      await sub.unsubscribe();
      toast({ message: result.message, tone: "error", duration: 0 });
      setState("apagado");
      return;
    }
    setEndpoint(sub.endpoint);
    setState("prendido");
    toast({ message: "Listo. Te avisamos en este dispositivo cuando alguien reserve.", tone: "ok" });
  }

  async function turnOff() {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const result = await deactivate({ endpoint: sub.endpoint });
      if (!result.ok) {
        toast({ message: result.message, tone: "error", duration: 0 });
        return;
      }
      await sub.unsubscribe();
    }
    setEndpoint(null);
    setState("apagado");
  }

  async function onChange(checked: boolean) {
    setBusy(true);
    try {
      if (checked) await turnOn();
      else await turnOff();
    } catch (error) {
      console.error("[ajustes] no se pudo cambiar los avisos", error);
      toast({ message: "El navegador no dejó cambiar los avisos. Intenta de nuevo.", tone: "error", duration: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    if (!endpoint) return;
    setBusy(true);
    try {
      const result = await test({ endpoint });
      toast({
        message: result.message ?? "Enviado.",
        tone: result.ok ? "ok" : "error",
        duration: result.ok ? undefined : 0,
      });
    } finally {
      setBusy(false);
    }
  }

  if (state === "cargando") {
    return <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>Revisando este dispositivo…</p>;
  }

  if (state === "instalar-ios") {
    return (
      <p style={{ margin: 0 }}>
        En iPhone los avisos solo llegan a la app instalada. Toca <strong>Compartir</strong> →{" "}
        <strong>Agregar a inicio</strong>, abre el panel desde ese ícono y vuelve a esta pantalla.
      </p>
    );
  }

  if (state === "sin-soporte") {
    return (
      <p style={{ margin: 0 }}>
        Este navegador no recibe avisos. En Android usa Chrome; en iPhone, el panel instalado en la
        pantalla de inicio.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <Checkbox
        label={onlyOwn ? "Avisarme cuando me agenden una cita" : "Avisarme cuando alguien reserve en la página"}
        hint={
          onlyOwn
            ? "Solo en este dispositivo, y solo tus citas. El aviso dice el servicio, el nombre, el día y la hora. Nunca el teléfono de la clienta."
            : "Solo en este dispositivo. El aviso dice el servicio, el nombre, el día y la hora, y con quién. Nunca el teléfono de quien reserva."
        }
        checked={state === "prendido"}
        disabled={busy || state === "bloqueado"}
        onChange={(e) => void onChange(e.currentTarget.checked)}
      />
      {state === "bloqueado" ? (
        <p role="status" style={{ margin: 0, color: "var(--color-error-ink)", fontSize: "var(--text-sm)" }}>
          Los avisos están bloqueados para el panel en este navegador. Actívalos en los ajustes del
          sitio (el candado junto a la dirección) y recarga esta pantalla.
        </p>
      ) : null}
      {state === "prendido" ? (
        <div>
          <Button size="sm" onClick={() => void onTest()} disabled={busy}>
            Mandarme un aviso de prueba
          </Button>
        </div>
      ) : null}
    </div>
  );
}
