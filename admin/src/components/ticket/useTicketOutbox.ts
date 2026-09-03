"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  dropDraft,
  enqueue,
  flushOutbox,
  listPending,
  newRequestId,
  readDraft,
  recordFailure,
  resolvePending,
  writeDraft,
  type DraftStorage,
  type PendingTicket,
  type SendOutcome,
} from "./draft-store";
import type { TicketDraft } from "./draft";
import type { CloseTicketAction, CloseTicketResult } from "./types";

/**
 * El puente entre React y la cola de `draft-store.ts`.
 *
 * Toda la lógica interesante —qué se guarda, qué se reintenta, cuánto se
 * espera— vive en `draft-store.ts`, que es puro y está testeado sin navegador.
 * Acá solo queda lo que necesita el navegador de verdad: `localStorage`, el
 * evento `online`, un temporizador y el estado de React.
 *
 * Tres cosas que este archivo hace y conviene no "simplificar":
 *
 * - **Se encola antes de intentar.** Ver `enqueue()`. Si el celular se bloquea
 *   en medio del envío, lo que está en la cola vuelve; lo que solo estaba en
 *   memoria, no.
 * - **`localStorage` se resuelve después de montar**, no en el cuerpo del
 *   componente. En el render del servidor no existe, y leerlo durante el render
 *   rompe la hidratación.
 * - **El temporizador corre siempre**, no solo cuando `navigator.onLine` es
 *   `false`. El wifi del estudio no se cae limpio: se queda asociado sin salida,
 *   y en ese estado `onLine` sigue diciendo `true`. El evento `online` es un
 *   atajo cuando llega, no la condición.
 */

const TICK_MS = 15_000;

export type OutboxApi = {
  /** Lo que falta mandar, por `ea_appointment_id`. */
  pending: ReadonlyMap<number, PendingTicket>;
  /** El navegador no deja escribir. La hoja lo avisa. */
  storageBlocked: boolean;
  /** Lo último que dijo `navigator.onLine`. Solo para el cartel. */
  online: boolean;
  /** Lo que había escrito de esta cuenta, o `null`. */
  restore: (eaAppointmentId: number) => TicketDraft | null;
  /** Guarda el borrador en curso. Se llama en cada tecla. */
  keep: (draft: TicketDraft) => void;
  /** Tira el borrador. */
  discard: (eaAppointmentId: number) => void;
  /** Encola y manda. Devuelve el desenlace para que la pantalla hable. */
  submit: (draft: TicketDraft) => Promise<SendOutcome>;
  /** Reintento manual, sin esperar el backoff. */
  retry: (eaAppointmentId: number) => Promise<void>;
};

/**
 * `localStorage`, o `null` si este navegador no lo presta.
 *
 * El acceso mismo lanza en una ventana privada de Safari y con las cookies de
 * sitio bloqueadas, así que no alcanza con comprobar que la propiedad exista:
 * hay que escribir una vez para saberlo.
 */
function resolveStorage(): DraftStorage | null {
  try {
    const storage = window.localStorage;
    const probe = "gbs.ticket.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Traduce el resultado de la Server Action al vocabulario de la cola.
 *
 * `retryable` lo decide el servidor y no este archivo: solo él sabe si el
 * problema fue "la base no contestó" (se reintenta) o "esta cuenta ya está en
 * un cierre diario" (no se reintenta nunca).
 */
function outcomeOf(result: CloseTicketResult): SendOutcome {
  if (result.ok) return { status: "ok" };
  return result.retryable
    ? { status: "reintentar", message: result.message }
    : { status: "rechazado", message: result.message };
}

const EMPTY: ReadonlyMap<number, PendingTicket> = new Map();

export function useTicketOutbox({
  scope,
  action,
  onSaved,
}: {
  scope: string;
  action: CloseTicketAction;
  /** Se llama cuando el servidor confirmó. La pantalla refresca sus datos. */
  onSaved?: (result: Extract<CloseTicketResult, { ok: true }>) => void;
}): OutboxApi {
  const [pending, setPending] = useState<ReadonlyMap<number, PendingTicket>>(EMPTY);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [online, setOnline] = useState(true);

  // `localStorage` se resuelve una sola vez, y nunca durante el render.
  const storageRef = useRef<DraftStorage | null>(null);
  const resolvedRef = useRef(false);

  // Las props cambian de identidad en cada pintura del servidor. Guardadas en
  // refs, el intervalo y los oyentes no se vuelven a suscribir por eso.
  const actionRef = useRef(action);
  const savedRef = useRef(onSaved);

  useEffect(() => {
    actionRef.current = action;
    savedRef.current = onSaved;
  });

  const getStorage = useCallback((): DraftStorage | null => {
    if (!resolvedRef.current) {
      resolvedRef.current = true;
      storageRef.current = resolveStorage();
    }
    return storageRef.current;
  }, []);

  /**
   * Lee el estado del sistema externo (el disco y la red) y lo mete en React.
   *
   * Es el único punto donde entra ese estado, y por eso lo llaman todos los
   * caminos: el montaje, el latido, el evento `online` y cada envío.
   */
  const syncFromStorage = useCallback(() => {
    const store = getStorage();
    setStorageBlocked(store === null);
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    setPending(
      store === null
        ? EMPTY
        : new Map(listPending(store, scope).map((p) => [p.draft.eaAppointmentId, p])),
    );
  }, [getStorage, scope]);

  const send = useCallback(async (p: PendingTicket): Promise<SendOutcome> => {
    const result = await actionRef.current({
      eaAppointmentId: p.draft.eaAppointmentId,
      performedServiceId: p.draft.performedServiceId,
      extras: p.draft.extras,
      manual: p.draft.manual,
      totalOverride: p.draft.totalOverride,
      varianceReasonCode: p.draft.varianceReasonCode,
      varianceReason: p.draft.varianceReason,
      notes: p.draft.notes,
      paymentMethod: p.draft.paymentMethod,
      tip: p.draft.tip,
      clientRequestId: p.clientRequestId,
    });
    if (result.ok) savedRef.current?.(result);
    return outcomeOf(result);
  }, []);

  const flush = useCallback(
    async (force: boolean) => {
      const store = getStorage();
      if (store === null) return;
      await flushOutbox(store, scope, send, { force });
      syncFromStorage();
    },
    [getStorage, scope, send, syncFromStorage],
  );

  // Al montar se lee el disco **y se intenta mandar lo que quedó**, sin esperar
  // el backoff. La página acaba de cargar desde el servidor: no hay mejor
  // prueba de que la red volvió. Hacer esperar cuarenta segundos a una cuenta
  // que quedó de ayer convierte "se manda sola" en "recargá y esperá", y el
  // caso real es exactamente ése — la técnica bloquea el celular con el wifi
  // caído y lo desbloquea cuando ya volvió.
  //
  // `syncFromStorage` y `flush` son estables (sus dependencias también lo son),
  // así que esto corre una vez por montaje.
  useEffect(() => {
    syncFromStorage();
    void flush(true);
  }, [syncFromStorage, flush]);

  // El latido y los oyentes. Los tres llaman al mismo `flush`, que respeta el
  // backoff salvo que se lo fuerce.
  useEffect(() => {
    const tick = setInterval(() => void flush(false), TICK_MS);

    const wake = () => {
      setOnline(true);
      void flush(true);
    };
    const sleep = () => setOnline(false);
    // Volver a la pestaña después de un rato es el otro momento en que el wifi
    // ya volvió y nadie se enteró.
    const focus = () => void flush(false);

    window.addEventListener("online", wake);
    window.addEventListener("offline", sleep);
    window.addEventListener("focus", focus);

    return () => {
      clearInterval(tick);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", sleep);
      window.removeEventListener("focus", focus);
    };
  }, [flush]);

  const restore = useCallback(
    (eaAppointmentId: number) => {
      const store = getStorage();
      return store === null ? null : readDraft(store, scope, eaAppointmentId);
    },
    [getStorage, scope],
  );

  const keep = useCallback(
    (draft: TicketDraft) => {
      const store = getStorage();
      if (store === null) return;
      if (!writeDraft(store, scope, draft)) setStorageBlocked(true);
    },
    [getStorage, scope],
  );

  const discard = useCallback(
    (eaAppointmentId: number) => {
      const store = getStorage();
      if (store !== null) dropDraft(store, scope, eaAppointmentId);
    },
    [getStorage, scope],
  );

  const submit = useCallback(
    async (draft: TicketDraft): Promise<SendOutcome> => {
      const id = draft.eaAppointmentId;
      const store = getStorage();

      // Sin `localStorage` no hay red de seguridad, pero sí hay que poder
      // guardar: el estudio no deja de trabajar porque el navegador tenga las
      // cookies bloqueadas. Se manda en directo y el aviso ya está en pantalla.
      if (store === null) {
        try {
          return await send({
            draft,
            clientRequestId: newRequestId(),
            queuedAt: Date.now(),
            attempts: 0,
            lastAttemptAt: null,
            lastError: null,
          });
        } catch (error) {
          return {
            status: "reintentar",
            message: error instanceof Error ? error.message : "No se pudo enviar",
          };
        }
      }

      if (!writeDraft(store, scope, draft)) setStorageBlocked(true);
      const queued = enqueue(store, scope, draft, newRequestId());
      syncFromStorage();

      let outcome: SendOutcome;
      try {
        outcome = await send(queued);
      } catch (error) {
        // Que `send` lance es el caso normal de una Server Action sin red: el
        // `fetch` de React rechaza. Es reintentable, que es lo que es.
        outcome = {
          status: "reintentar",
          message: error instanceof Error ? error.message : "No se pudo enviar",
        };
      }

      if (outcome.status === "ok") {
        resolvePending(store, scope, id, false);
      } else if (outcome.status === "rechazado") {
        // El borrador **se queda**: hay algo que corregir, y borrarle lo escrito
        // sería castigarla por un error de validación.
        resolvePending(store, scope, id, true);
      } else {
        // `attempts` es lo que gobierna el backoff: sin incrementarlo, el latido
        // reintentaría cada quince segundos para siempre.
        recordFailure(store, scope, queued, outcome.message);
      }

      syncFromStorage();
      return outcome;
    },
    [getStorage, scope, send, syncFromStorage],
  );

  const retry = useCallback(
    async (eaAppointmentId: number) => {
      const store = getStorage();
      if (store === null) return;
      const p = listPending(store, scope).find(
        (x) => x.draft.eaAppointmentId === eaAppointmentId,
      );
      if (p === undefined) return;
      // Se fuerza el flush completo y no solo esta cuenta: si la red volvió,
      // volvió para todas, y mandar una y dejar dos esperando cuarenta segundos
      // no le sirve a nadie.
      await flush(true);
    },
    [getStorage, scope, flush],
  );

  return { pending, storageBlocked, online, restore, keep, discard, submit, retry };
}
