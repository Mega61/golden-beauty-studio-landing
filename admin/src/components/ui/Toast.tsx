"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

/**
 * Toasts, con Deshacer.
 *
 * El plan es explícito: **toda acción destructiva ofrece Deshacer en el toast
 * en vez de un "¿Está seguro?"**, salvo cancelar una cita, que además notifica
 * a la clienta y por eso sí confirma. La razón es de flujo: la recepción hace
 * treinta gestos por hora y un diálogo de confirmación deja de leerse a los
 * tres días. Deshacer, en cambio, la ayuda justo cuando se equivocó.
 *
 * Consecuencia de diseño que hay que respetar en los paquetes que lo usen: si
 * hay Deshacer, **la escritura ya ocurrió**. El toast no es una ventana para
 * arrepentirse antes de guardar; es la forma de revertir algo que ya se
 * guardó. Un "deshacer" que en realidad retrasa la escritura seis segundos
 * deja la agenda mintiendo durante esos seis segundos, y dos personas editando
 * a la vez es el caso normal en este estudio.
 *
 * Accesibilidad: la región es `aria-live="polite"` y `role="status"`, así se
 * anuncia sin cortar lo que el lector esté leyendo. El temporizador se
 * **pausa** con el puntero encima o con el foco dentro: un toast con Deshacer
 * que se va mientras alguien lo está tabulando es una acción destruida por el
 * reloj.
 */

export type ToastTone = "neutral" | "ok" | "warn" | "error";

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  /** Milisegundos. `0` = no se va solo (para errores que hay que leer). */
  duration?: number;
  undo?: {
    label?: string;
    /** Revierte la escritura que ya ocurrió. */
    onUndo: () => void | Promise<void>;
  };
};

type ToastItem = ToastInput & { id: number };

type ToastApi = {
  toast: (t: ToastInput) => number;
  dismiss: (id: number) => void;
};

const Ctx = createContext<ToastApi | null>(null);

/**
 * Se monta una sola vez, en el layout raíz. Vive fuera del `<main>` para que la
 * región `aria-live` no se desmonte al navegar entre pantallas — si se
 * desmonta, el anuncio se pierde justo cuando importa.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    // Tres a la vez es el techo: más que eso tapa la barra inferior en un
    // celular y el cuarto mensaje entierra al primero antes de que se lea.
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
    return id;
  }, []);

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="ui-toaster" role="status" aria-live="polite">
        {items.map((t) => (
          <ToastRow key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useToast necesita un <ToastProvider> arriba en el árbol.");
  }
  return ctx;
}

const DEFAULT_MS = 5000;
/** Con Deshacer se da más aire: hay que leer, decidir y apuntar al botón. */
const UNDO_MS = 9000;

function ToastRow({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [undone, setUndone] = useState(false);
  const duration =
    item.duration ?? (item.undo ? UNDO_MS : item.tone === "error" ? 0 : DEFAULT_MS);

  useEffect(() => {
    if (duration === 0 || paused || undone) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, paused, undone, onDismiss]);

  const tone = item.tone ?? "neutral";

  return (
    <div
      className={`ui-toast${tone === "neutral" ? "" : ` ui-toast--${tone}`}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {tone !== "neutral" ? (
        <Icon
          name={tone === "ok" ? "check" : tone === "error" ? "alerta" : "info"}
          size={18}
          style={{ flex: "none" }}
        />
      ) : null}
      <span className="ui-toast__text">{item.message}</span>
      {item.undo && !undone ? (
        <button
          type="button"
          className="ui-toast__undo"
          onClick={async () => {
            setUndone(true);
            await item.undo?.onUndo();
            onDismiss();
          }}
        >
          <Icon name="deshacer" size={14} style={{ verticalAlign: "-2px" }} />{" "}
          {item.undo.label ?? "Deshacer"}
        </button>
      ) : null}
      <button
        type="button"
        className="ui-toast__close"
        onClick={onDismiss}
        aria-label="Descartar el aviso"
      >
        <Icon name="cerrar" size={16} />
      </button>
    </div>
  );
}
