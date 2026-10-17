"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { attendanceView, attendanceWindowOpen, type AttendanceMark } from "@/lib/attendance";
import { instantToEaLocal, type EaLocalDateTime } from "@/lib/ea/datetime";

import { marcarAsistencia } from "./attendance-actions";

/**
 * "Llegó" / "No asistió", con su "Deshacer". Lo usan la tarjeta de Hoy y el
 * detalle de la cita en la agenda.
 *
 * Un toque, sin formulario: la técnica lo marca entre dos clientas. Las reglas
 * —cuándo se ofrece, qué se escribe, cuándo se puede deshacer— son de
 * `lib/attendance.ts`; acá solo se dibujan y se llama la acción.
 *
 * - **"No asistió" confirma; "Llegó" no.** El `PUT` de estado puede mandarle a
 *   la clienta un correo de "tu cita cambió" (si tiene correo, que casi nunca).
 *   Marcar que vino es rutina; acusar una inasistencia por un dedo resbalado no.
 * - **Deshacer, dos veces.** En el toast, justo después del toque —con el
 *   estado exacto que había, "Confirmada" incluida—, y en la tarjeta mientras la
 *   cuenta no esté cerrada, para el error que se nota una hora después.
 * - **La marca se ve en cuanto EA la acepta**, sin esperar el refresco de la
 *   pantalla que la contiene (que se pide con `onMarked`). Antes de eso el
 *   botón muestra que está trabajando; no se pinta una marca que EA todavía
 *   puede rechazar. Si dice que no, el toast dice por qué.
 */
export function AttendanceControl({
  eaAppointmentId,
  start,
  status,
  closed,
  readOnly = false,
  onMarked,
}: {
  eaAppointmentId: number;
  /** Hora de pared de inicio, como la trae EA. */
  start: string;
  /** El `status` crudo de EA. */
  status: string;
  /** `null` = esta pantalla no sabe si la cuenta está cerrada (la agenda). */
  closed: boolean | null;
  readOnly?: boolean;
  /** Después de escribir en EA: para refrescar y, en Hoy, abrir la cuenta. */
  onMarked?: (outcome: { mark: AttendanceMark; eaStatus: string }) => void;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const now = useNowLocal();

  // La marca local vale mientras la pantalla siga mostrando el estado del que
  // partió. Cuando llega el refresco con el estado nuevo, se descarta sola
  // — sin un efecto que la limpie.
  const [optimistic, setOptimistic] = useState<{ from: string; to: string } | null>(null);
  const effective = optimistic !== null && optimistic.from === status ? optimistic.to : status;

  if (readOnly) return null;

  const view = attendanceView({
    status: effective,
    closed,
    windowOpen: now !== null && attendanceWindowOpen(start, now),
  });

  if (view.kind === "nada" || view.kind === "temprano") return null;

  const run = (mark: AttendanceMark, restoreTo?: string) => {
    const previous = effective;
    startTransition(async () => {
      const result = await marcarAsistencia({ eaAppointmentId, mark, restoreTo });
      if (result.status === "error") {
        setOptimistic(null);
        toast({ message: result.message, tone: "error", duration: 0 });
        return;
      }

      setOptimistic({ from: status, to: result.eaStatus });
      onMarked?.({ mark, eaStatus: result.eaStatus });

      if (mark === "deshacer") {
        toast({ message: "Marca deshecha.", tone: "neutral" });
        return;
      }
      toast({
        message: mark === "llego" ? "Marcada: llegó." : "Marcada: no asistió.",
        tone: mark === "llego" ? "ok" : "warn",
        undo: {
          // La escritura ya ocurrió: Deshacer la revierte al estado exacto que
          // había antes del toque.
          onUndo: () => run("deshacer", previous),
        },
      });
    });
  };

  if (view.kind === "marcada") {
    return (
      <div style={rowStyle} role="group" aria-label="Asistencia">
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3125rem",
            fontSize: "var(--text-2xs)",
            fontWeight: 600,
            color:
              view.mark === "llego"
                ? "var(--color-st-completada-ink)"
                : "var(--color-st-no-asistio-ink)",
          }}
        >
          <Icon name={view.mark === "llego" ? "check" : "alerta"} size={14} />
          {view.mark === "llego" ? "Llegó" : "No asistió"}
        </span>
        {view.undoable ? (
          <Button
            size="sm"
            variant="ghost"
            icon="deshacer"
            loading={pending}
            loadingLabel="Deshaciendo"
            onClick={() => run("deshacer")}
          >
            Deshacer
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={rowStyle} role="group" aria-label="¿Llegó la clienta?">
      <Button
        icon="check"
        loading={pending}
        loadingLabel="Marcando"
        onClick={() => run("llego")}
        style={{ flex: 1 }}
      >
        Llegó
      </Button>
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (
            !globalThis.confirm(
              "¿Marcar que la clienta no asistió? Cuenta en la inasistencia del estudio.",
            )
          ) {
            return;
          }
          run("no-asistio");
        }}
        style={{ flex: 1, color: "var(--color-st-no-asistio-ink)" }}
      >
        No asistió
      </Button>
    </div>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
} as const;

// ── El reloj ────────────────────────────────────────────────────────────────

function subscribeToMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * "Ahora" en hora de pared del estudio, al minuto, y `null` en el servidor.
 *
 * Mismo patrón que `useNow()` de la agenda: el reloj es un sistema externo y va
 * con `useSyncExternalStore`. En el servidor no hay botones —no se sabe la
 * hora del navegador— y aparecen al hidratar; un botón que se dibuja en el
 * servidor con la hora del proceso podría ofrecer marcar una cita que todavía
 * no empezó.
 */
function useNowLocal(): EaLocalDateTime | null {
  const minute = useSyncExternalStore(subscribeToMinute, currentMinute, () => null);
  return minute === null ? null : instantToEaLocal(new Date(minute * 60_000));
}
