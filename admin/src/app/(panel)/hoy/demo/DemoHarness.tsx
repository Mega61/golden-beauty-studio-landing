"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import { Checkbox } from "@/components/ui";
import {
  priceDraft,
  type CloseTicketInput,
  type CloseTicketResult,
  type TicketDraft,
} from "@/components/ticket";
import { TodayList } from "../TodayList";
import { CATALOGO_DEMO, CITAS_DEMO } from "./fixtures";

/**
 * El banco de pruebas de "Cerrar servicio".
 *
 * Reemplaza la Server Action por una que corre en el navegador y valora la
 * cuenta con el mismo `priceDraft()` que usa la hoja. Lo que **no** reemplaza
 * es nada del camino que importa: la hoja, el borrador, la cola, el backoff y
 * los tres desenlaces son exactamente los de producción.
 *
 * El interruptor de "sin conexión" hace que el envío rechace igual que un
 * `fetch` sin red, que es lo que hace React cuando una Server Action no llega.
 * Con eso se puede comprobar a mano —y con Playwright— la exigencia que no es
 * opcional: **escribir, quedarse sin wifi, recargar la página y encontrar todo
 * ahí**, y que vuelva sola cuando la red regresa.
 */

/**
 * Los interruptores viven en `sessionStorage` y **sobreviven a recargar**.
 *
 * No es comodidad: la prueba que importa es escribir sin wifi, recargar y
 * encontrar todo ahí. Si al recargar la red "volviera" sola, la cola se
 * vaciaría antes de que se pudiera mirar. Con el interruptor persistido el
 * celular sigue sin señal después de recargar, igual que en el estudio.
 */
const SWITCH_KEY = "gbs.ticket.demo.switches";

const EMPTY_SWITCHES = "{}";

function rawSwitches(): string {
  try {
    return sessionStorage.getItem(SWITCH_KEY) ?? EMPTY_SWITCHES;
  } catch {
    return EMPTY_SWITCHES;
  }
}

function parseSwitches(raw: string): { offline: boolean; rechazar: boolean } {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return { offline: o.offline === true, rechazar: o.rechazar === true };
  } catch {
    return { offline: false, rechazar: false };
  }
}

function readSwitches(): { offline: boolean; rechazar: boolean } {
  return parseSwitches(rawSwitches());
}

/** Los oyentes de `useSyncExternalStore`. `sessionStorage` no avisa solo. */
const listeners = new Set<() => void>();

function subscribeSwitches(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function writeSwitches(patch: { offline?: boolean; rechazar?: boolean }): void {
  const next = { ...readSwitches(), ...patch };
  try {
    sessionStorage.setItem(SWITCH_KEY, JSON.stringify(next));
  } catch {
    // Sin sessionStorage el banco sigue sirviendo; solo no sobrevive a recargar.
  }
  for (const fn of listeners) fn();
}

export function DemoHarness() {
  const [guardadas, setGuardadas] = useState<string[]>([]);

  // `useSyncExternalStore` en vez de estado más efecto: el disco es un sistema
  // externo, el servidor no lo tiene, y esta API existe justo para leer uno sin
  // romper la hidratación ni encadenar renders.
  const raw = useSyncExternalStore(subscribeSwitches, rawSwitches, () => EMPTY_SWITCHES);
  const { offline, rechazar } = parseSwitches(raw);
  const flip = writeSwitches;

  // La acción **lee el disco, no el estado de React**. El efecto de montaje de
  // `useTicketOutbox` corre antes que el de este componente —los hijos primero—,
  // así que una copia en memoria todavía diría "con señal" cuando la cola ya
  // está intentando mandar. El disco no tiene ese problema.
  const action = useCallback(async (input: CloseTicketInput): Promise<CloseTicketResult> => {
    const sw = readSwitches();
    await new Promise((r) => setTimeout(r, 300));

    if (sw.offline) {
      // Es literalmente lo que lanza el `fetch` de React cuando no hay red.
      throw new TypeError("Failed to fetch");
    }

    if (sw.rechazar) {
      return { ok: false, retryable: false, message: "Esta cita no es tuya." };
    }

    const cita = CITAS_DEMO.find((c) => c.eaAppointmentId === input.eaAppointmentId);
    const draft: TicketDraft = { ...input, version: 1, updatedAt: Date.now() };
    const r = priceDraft(draft, CATALOGO_DEMO, {
      bookedServiceId: cita?.bookedServiceId ?? null,
      bookedSnapshot: cita?.finance.snapshot ?? null,
    });

    if (r.errors.length > 0 || r.totals === null) {
      return { ok: false, retryable: false, message: r.errors[0] ?? "Cuenta inválida" };
    }

    setGuardadas((xs) => [
      ...xs,
      `#${input.eaAppointmentId} · ${r.totals?.amountCharged} + propina ${r.totals?.tip}`,
    ]);

    return {
      ok: true,
      eaAppointmentId: input.eaAppointmentId,
      financeId: 900 + input.eaAppointmentId,
      amountCharged: r.totals.amountCharged,
      tip: r.totals.tip,
      closedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    };
  }, []);

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div
        style={{
          display: "grid",
          gap: "0.25rem",
          padding: "0.75rem",
          borderRadius: "var(--radius-md)",
          border: "1px dashed var(--hair-strong)",
          background: "var(--color-ivory-deep)",
        }}
      >
        <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          Banco de pruebas · datos de mentira · no existe en producción
        </p>
        <Checkbox
          label="Simular sin conexión"
          hint="El envío falla como un fetch sin red: la cuenta queda pendiente y se reintenta sola."
          checked={offline}
          onChange={(e) => flip({ offline: e.target.checked })}
        />
        <Checkbox
          label="Simular rechazo del servidor"
          hint="Sale de la cola y conserva lo escrito, sin reintentar."
          checked={rechazar}
          onChange={(e) => flip({ rechazar: e.target.checked })}
        />
        {guardadas.length > 0 ? (
          <p
            data-testid="demo-guardadas"
            style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ok-ink)" }}
          >
            Guardadas: {guardadas.join(" · ")}
          </p>
        ) : null}
      </div>

      <TodayList
        appointments={CITAS_DEMO}
        catalog={CATALOGO_DEMO}
        scope="demo"
        canCharge
        canSeeTotals
        canFixAfterClose={false}
        readOnly={false}
        action={action}
      />
    </div>
  );
}
