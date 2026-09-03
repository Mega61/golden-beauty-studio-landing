"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";

import {
  DaySheet,
  RangeBar,
  ResourceGrid,
  datesFor,
  visibleWindow,
  type MovePick,
  type RangeMode,
  type ResizePick,
  type SlotPick,
} from "@/components/calendar";
import styles from "@/components/calendar/calendar.module.css";
import { unmappedStatuses } from "@/components/calendar/status-map";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelInline } from "@/components/ui/Panel";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatDateLong, formatPhoneCO, formatTimeRange } from "@/components/ui/format";
import { useToast } from "@/components/ui/Toast";
import { buildDayGrid, type DayGrid } from "@/lib/calendar-layout";
import type { ConflictReport } from "@/lib/conflict";
import { addMinutes, eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";
import { cancelAppointment, saveAppointment, saveBlock } from "./actions";
import { AppointmentForm, type AppointmentDraft } from "./AppointmentForm";
import { BlockForm } from "./BlockForm";
import type { BlockForm as BlockFormValues } from "./block-resource";
import type { AgendaData } from "./data";

/**
 * La pantalla de la agenda, del lado del navegador.
 *
 * Lo que hace, y en este orden de importancia:
 *
 * 1. **Rearma la grilla con `buildDayGrid()`** cada vez que llegan datos
 *    nuevos. El servidor manda datos crudos, no una grilla ya hecha: así hay un
 *    solo camino —el mismo en el primer render y en el refresco número
 *    cuarenta— y la agenda no puede verse distinta según por dónde llegó el
 *    dato.
 * 2. **Refresca sola.** Polling del rango visible cada 30 s y refetch al
 *    recuperar el foco de la ventana. Que dos personas editen a la vez es el
 *    caso normal de este estudio, no el raro.
 * 3. **Escribe optimista y revierte.** El bloque se mueve al instante; si el PUT
 *    falla vuelve a su sitio y un toast explica por qué. Y como la escritura ya
 *    ocurrió cuando sale el toast, "Deshacer" **revierte** en vez de retrasar
 *    (la regla de A3): retrasar dejaría la agenda mintiendo seis segundos.
 * 4. **Muestra lo que no se ve.** Citas huérfanas, ocultas antes o después de la
 *    jornada, y estados que el panel no supo traducir. Una cita que desaparece
 *    sin aviso es el peor modo de falla de esta pantalla.
 */

export type AgendaClientProps = {
  initial: AgendaData;
  mode: RangeMode;
  anchor: EaLocalDate;
  today: EaLocalDate;
  /** `null` si EA respondió. Con texto, la pantalla está en solo lectura. */
  eaFailure: string | null;
  /** La técnica solo puede bloquearse a sí misma. `null` en dueña y recepción. */
  ownProviderId: number | null;
  canWrite: boolean;
};

/** Cada cuánto se vuelve a pedir el rango visible. */
const POLL_MS = 30_000;

/** A partir de acá el detalle cabe al lado de la grilla sin taparla. */
const SIDE_PANEL_QUERY = "(min-width: 90rem)";

type PanelState =
  | { kind: "none" }
  | { kind: "detail"; appointment: Appointment }
  | { kind: "form"; draft: AppointmentDraft }
  | { kind: "block"; date: EaLocalDate; providerId: number | null };

export function AgendaClient({
  initial,
  mode: initialMode,
  anchor: initialAnchor,
  today,
  eaFailure,
  ownProviderId,
  canWrite,
}: AgendaClientProps) {
  const { toast } = useToast();

  const [mode, setMode] = useState<RangeMode>(initialMode);
  const [anchor, setAnchor] = useState<EaLocalDate>(initialAnchor);
  const [data, setData] = useState<AgendaData>(initial);
  const [failure, setFailure] = useState<string | null>(eaFailure);
  const [expand, setExpand] = useState({ before: 0, after: 0 });
  const [panel, setPanel] = useState<PanelState>({ kind: "none" });
  const [movingId, setMovingId] = useState<number | null>(null);
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [report, setReport] = useState<ConflictReport | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState(false);
  const [saving, startSave] = useTransition();
  const now = useNow();

  const dates = useMemo(() => datesFor(mode, anchor), [mode, anchor]);
  const dateKey = dates.join(",");

  useEffect(() => {
    const query = window.matchMedia(SIDE_PANEL_QUERY);
    const sync = () => setSidePanel(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // ── Refresco ─────────────────────────────────────────────────────────────

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`datos?dias=${dateKey}`, {
          signal,
          cache: "no-store",
        });

        if (response.status === 503) {
          const body = (await response.json()) as { error?: string };
          setFailure(body.error ?? "Easy!Appointments no responde.");
          return;
        }
        if (!response.ok) return;

        setData((await response.json()) as AgendaData);
        setFailure(null);
      } catch {
        // Un `AbortError` al cambiar de día no es una falla, y un fallo de red
        // suelto tampoco tiene por qué borrar lo que ya se está viendo: el
        // siguiente intento llega en treinta segundos.
      }
    },
    [dateKey],
  );

  // Al cambiar el rango se pide de inmediato: el servidor solo trajo el rango
  // con el que se abrió la pantalla.
  const firstRange = useRef(dateKey);
  useEffect(() => {
    if (firstRange.current === dateKey) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [dateKey, refresh]);

  // Polling + refetch al recuperar el foco. El intervalo se pausa con la
  // pestaña escondida: treinta consultas por minuto a EA desde diez pestañas
  // olvidadas es carga real sobre una VM chica.
  useEffect(() => {
    const controller = new AbortController();

    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refresh(controller.signal);
    };

    const timer = setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);

    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // La URL sigue al estado sin volver al servidor: `history.replaceState` deja
  // el enlace compartible y no dispara una navegación que pediría los mismos
  // datos que el polling ya trae.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("rango", mode);
    url.searchParams.set("dia", anchor);
    window.history.replaceState(null, "", url.toString());
  }, [mode, anchor]);

  // ── La grilla ────────────────────────────────────────────────────────────

  const window_ = useMemo(
    () => visibleWindow(data.providers, dates, expand.before, expand.after),
    [data.providers, dates, expand],
  );

  const grids: DayGrid[] = useMemo(
    () =>
      dates.map((date) =>
        buildDayGrid({
          range: {
            date,
            startMinute: window_.startMinute,
            endMinute: window_.endMinute,
            // 15 minutos es la rejilla de EA y la del estudio. No sale de un
            // servicio concreto a propósito: la grilla es una sola y no puede
            // cambiar de paso según qué cita se mire.
            slotMinutes: 15,
          },
          providers: data.providers,
          appointments: data.appointments,
          unavailabilities: data.unavailabilities,
          blockedPeriods: data.blockedPeriods,
          now,
        }),
      ),
    [dates, window_, data, now],
  );

  const orphans = grids[0]?.orphanAppointments ?? [];
  const unknown = useMemo(
    () => unmappedStatuses(data.appointments.map((a) => a.status)),
    [data.appointments],
  );

  // ── Escrituras ───────────────────────────────────────────────────────────

  /**
   * Aplica un cambio en local antes de que el servidor conteste, y devuelve
   * cómo deshacerlo.
   *
   * Es el corazón del "optimista con rollback": el bloque se mueve al instante y
   * si el PUT falla vuelve exactamente a donde estaba, porque el estado anterior
   * quedó capturado acá y no reconstruido después.
   */
  const applyLocal = useCallback((id: number, patch: Partial<Appointment>) => {
    let previous: Appointment | null = null;
    setData((current) => ({
      ...current,
      appointments: current.appointments.map((appointment) => {
        if (appointment.id !== id) return appointment;
        previous = appointment;
        return { ...appointment, ...patch };
      }),
    }));
    return () => {
      if (!previous) return;
      const restore = previous;
      setData((current) => ({
        ...current,
        appointments: current.appointments.map((a) => (a.id === id ? restore : a)),
      }));
    };
  }, []);

  const commitMove = useCallback(
    (appointment: Appointment, start: EaLocalDateTime, end: EaLocalDateTime, providerId: number) => {
      const rollback = applyLocal(appointment.id, { start, end, providerId });
      setPendingIds((ids) => [...ids, appointment.id]);
      setMovingId(null);

      startSave(async () => {
        const result = await saveAppointment({
          id: appointment.id,
          providerId,
          serviceId: appointment.serviceId ?? 0,
          customerId: appointment.customerId ?? 0,
          start,
          end,
        });

        setPendingIds((ids) => ids.filter((id) => id !== appointment.id));

        if (result.status === "ok") {
          toast({
            message: "Cita movida.",
            tone: "ok",
            undo: {
              // La escritura ya ocurrió: Deshacer revierte, no cancela. Se
              // manda `force` porque el sitio original acaba de quedar libre
              // pero el motor podría ver algo que entró en el medio, y en un
              // deshacer la intención es explícita.
              onUndo: () => {
                rollback();
                void saveAppointment({
                  id: appointment.id,
                  providerId: appointment.providerId ?? providerId,
                  serviceId: appointment.serviceId ?? 0,
                  customerId: appointment.customerId ?? 0,
                  start: appointment.start,
                  end: appointment.end,
                  force: true,
                });
              },
            },
          });
          void refresh();
          return;
        }

        rollback();

        if (result.status === "conflict") {
          // Un choque al arrastrar no abre un diálogo encima de la grilla: el
          // bloque vuelve y el toast dice qué pasó. El diálogo con "Guardar de
          // todas formas" es del formulario, donde hay sitio para leerlo.
          toast({
            message: `No se movió: ${result.report.conflicts[0]?.message ?? "hay un choque."}`,
            tone: "warn",
            duration: 0,
          });
          return;
        }

        toast({ message: result.message, tone: "error" });
      });
    },
    [applyLocal, refresh, toast],
  );

  const onMove = useCallback(
    ({ appointment, providerId, date, minute }: MovePick) => {
      const length = lengthMinutes(appointment);
      const start = atMinute(date, minute);
      commitMove(appointment, start, addMinutes(start, length), providerId);
    },
    [commitMove],
  );

  const onResize = useCallback(
    ({ appointment, endMinute }: ResizePick) => {
      const date = eaDatePart(appointment.start);
      commitMove(
        appointment,
        appointment.start,
        atMinute(date, endMinute),
        appointment.providerId ?? 0,
      );
    },
    [commitMove],
  );

  const onPickSlot = useCallback(
    ({ providerId, date, minute }: SlotPick) => {
      // Con "Mover" armado, tocar un hueco es soltar. Es el gesto táctil que
      // reemplaza al arrastre.
      if (movingId !== null) {
        const appointment = data.appointments.find((a) => a.id === movingId);
        if (appointment) onMove({ appointment, providerId, date, minute });
        return;
      }

      setReport(null);
      setFormError(null);
      setPanel({
        kind: "form",
        draft: {
          providerId,
          serviceId: null,
          customerId: null,
          customerName: null,
          date,
          startTime: hhmm(minute),
          endTime: hhmm(minute + 60),
          notes: "",
          status: "Reservada",
        },
      });
    },
    [data.appointments, movingId, onMove],
  );

  const submitAppointment = (draft: AppointmentDraft, force: boolean) => {
    setFormError(null);
    startSave(async () => {
      const result = await saveAppointment({
        id: draft.id,
        providerId: draft.providerId,
        serviceId: draft.serviceId ?? 0,
        customerId: draft.customerId ?? 0,
        start: `${draft.date} ${draft.startTime}:00`,
        end: `${draft.date} ${draft.endTime}:00`,
        notes: draft.notes,
        status: draft.status,
        force,
      });

      if (result.status === "ok") {
        setPanel({ kind: "none" });
        setReport(null);
        toast({ message: draft.id ? "Cita guardada." : "Cita creada.", tone: "ok" });
        void refresh();
        return;
      }

      if (result.status === "conflict") {
        setReport(result.report);
        return;
      }

      setFormError(result.message);
    });
  };

  const submitBlock = (values: BlockFormValues) => {
    setFormError(null);
    startSave(async () => {
      const result = await saveBlock(values);

      if (result.status === "ok") {
        setPanel({ kind: "none" });
        toast({
          message:
            result.created === 1 ? "Bloqueo guardado." : `${result.created} bloqueos guardados.`,
          tone: "ok",
        });
        void refresh();
        return;
      }

      setFormError(
        result.status === "invalid"
          ? (result.errors[0]?.message ?? "Revisa el formulario.")
          : result.message,
      );
    });
  };

  const doCancel = (appointment: Appointment) => {
    // La única acción destructiva que **sí** confirma: cancelar notifica a la
    // clienta, y una notificación no se deshace (§ Interacción).
    if (!globalThis.confirm("Cancelar la cita le avisa a la clienta. ¿Seguro?")) return;

    startSave(async () => {
      const result = await cancelAppointment(appointment.id, appointment.providerId ?? 0);
      if (result.status === "ok") {
        setPanel({ kind: "none" });
        toast({ message: "Cita cancelada.", tone: "ok" });
        void refresh();
        return;
      }
      toast({
        message: result.status === "error" ? result.message : "No se pudo cancelar.",
        tone: "error",
      });
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const readOnly = !canWrite || failure !== null;

  const detail =
    panel.kind === "detail" ? (
      <AppointmentDetail
        appointment={panel.appointment}
        meta={data.meta}
        readOnly={readOnly}
        moving={movingId === panel.appointment.id}
        onMove={() => {
          setMovingId(panel.appointment.id);
          setPanel({ kind: "none" });
          toast({ message: "Toca el hueco de destino.", tone: "neutral", duration: 6000 });
        }}
        onEdit={() => {
          setReport(null);
          setFormError(null);
          setPanel({ kind: "form", draft: draftFrom(panel.appointment, data.meta) });
        }}
        onCancelAppointment={() => doCancel(panel.appointment)}
      />
    ) : null;

  const body =
    panel.kind === "form" ? (
      <AppointmentForm
        // El borrador es estado interno del formulario; cuando cambia la cita
        // que se está editando, el formulario se **remonta** en vez de
        // sincronizarse con un efecto. Es el patrón que recomienda React y el
        // que evita el render en cascada de un `setState` dentro de un efecto.
        key={formKey(panel.draft)}
        draft={panel.draft}
        providers={data.providers.map((p) => ({ id: p.id, name: p.name }))}
        services={data.services}
        meta={data.meta}
        report={report}
        error={formError}
        saving={saving}
        onSubmit={submitAppointment}
        onCancel={() => setPanel({ kind: "none" })}
      />
    ) : panel.kind === "block" ? (
      <BlockForm
        providers={data.providers.map((p) => ({ id: p.id, name: p.name }))}
        date={panel.date}
        providerId={panel.providerId}
        lockedProviderId={ownProviderId}
        saving={saving}
        error={formError}
        onSubmit={submitBlock}
        onCancel={() => setPanel({ kind: "none" })}
      />
    ) : (
      detail
    );

  const panelTitle =
    panel.kind === "form"
      ? panel.draft.id === undefined
        ? "Nueva cita"
        : "Editar cita"
      : panel.kind === "block"
        ? "Bloquear"
        : "Cita";

  return (
    <div className={styles.frame}>
      <RangeBar
        mode={mode}
        anchor={anchor}
        today={today}
        onMode={setMode}
        onAnchor={setAnchor}
        actions={
          <>
            <span className={styles.barSpacer} />
            <Button size="sm" variant="ghost" onClick={() => globalThis.print()}>
              Imprimir
            </Button>
            <Button
              size="sm"
              disabled={readOnly}
              onClick={() => {
                setFormError(null);
                setPanel({ kind: "block", date: dates[0], providerId: ownProviderId });
              }}
            >
              Bloquear
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={readOnly || data.providers.length === 0}
              onClick={() =>
                onPickSlot({
                  providerId: data.providers[0]?.id ?? 0,
                  date: dates[0],
                  minute: window_.startMinute,
                })
              }
            >
              Nueva cita
            </Button>
          </>
        }
      />

      <Notices
        failure={failure}
        orphans={orphans.length}
        unknown={unknown}
        moving={movingId !== null}
        onCancelMove={() => setMovingId(null)}
      />

      {data.providers.length === 0 ? (
        <EmptyState
          icon="equipo"
          title="Todavía no hay profesionales"
          body="La agenda dibuja una columna por profesional de Easy!Appointments. Sin ninguna, no hay dónde agendar."
        />
      ) : (
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <ResourceGrid
              days={grids}
              meta={data.meta}
              today={today}
              selectedId={panel.kind === "detail" ? panel.appointment.id : null}
              movingId={movingId}
              pendingIds={pendingIds}
              readOnly={readOnly}
              onPickSlot={onPickSlot}
              onPickAppointment={(appointment) => setPanel({ kind: "detail", appointment })}
              onMove={onMove}
              onResize={onResize}
              onRevealHidden={(direction) =>
                setExpand((current) =>
                  direction === -1
                    ? { ...current, before: current.before + 1 }
                    : { ...current, after: current.after + 1 },
                )
              }
            />
          </div>

          {/* ≥1440: el panel vive al lado y no tapa la grilla. Es la diferencia
              entre consultar una cita y perder de vista la tarde. */}
          {sidePanel && panel.kind !== "none" ? (
            <div className={styles.rowSide}>
              <PanelInline title={panelTitle} onClose={() => setPanel({ kind: "none" })}>
                {body}
              </PanelInline>
            </div>
          ) : null}
        </div>
      )}

      {!sidePanel ? (
        <Panel
          open={panel.kind !== "none"}
          onClose={() => setPanel({ kind: "none" })}
          title={panelTitle}
          dismissable={panel.kind === "detail"}
        >
          {body}
        </Panel>
      ) : null}

      <DaySheet days={grids} meta={data.meta} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

function Notices({
  failure,
  orphans,
  unknown,
  moving,
  onCancelMove,
}: {
  failure: string | null;
  orphans: number;
  unknown: readonly string[];
  moving: boolean;
  onCancelMove: () => void;
}) {
  if (!failure && orphans === 0 && unknown.length === 0 && !moving) return null;

  return (
    <div className={styles.notices}>
      {moving ? (
        <div className={styles.notice} role="status">
          <span style={{ flex: 1 }}>
            <strong>Moviendo una cita.</strong> Toca el hueco de destino.
          </span>
          <Button size="sm" variant="ghost" onClick={onCancelMove}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {failure ? (
        <div className={styles.notice} role="status">
          <span>
            <strong>{failure}</strong> La agenda está en solo lectura: se ve lo último que se pudo
            leer y no se puede guardar nada.
          </span>
        </div>
      ) : null}

      {/* Citas sin columna donde vivir. El motor las reporta en vez de
          descartarlas, y por eso acá se muestran: una cita que desaparece de la
          agenda sin aviso es el peor modo de falla de esta pantalla. */}
      {orphans > 0 ? (
        <div className={styles.notice} role="status">
          <span>
            <strong>
              {orphans} {orphans === 1 ? "cita no tiene profesional" : "citas no tienen profesional"}
            </strong>{" "}
            asignada, o la tienen fuera de la lista. No se dibujan en ninguna columna; hay que
            arreglarlas en Easy!Appointments.
          </span>
        </div>
      ) : null}

      {unknown.length > 0 ? (
        <div className={styles.notice} role="status">
          <span>
            <strong>Hay estados que el panel no reconoce.</strong> Se dibujan punteados. Revisa la
            lista de estados en Easy!Appointments:
            <ul className={styles.noticeList}>
              {unknown.map((raw) => (
                <li key={raw}>{raw === "" ? "(sin estado)" : `«${raw}»`}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------

function AppointmentDetail({
  appointment,
  meta,
  readOnly,
  moving,
  onMove,
  onEdit,
  onCancelAppointment,
}: {
  appointment: Appointment;
  meta: AgendaData["meta"];
  readOnly: boolean;
  moving: boolean;
  onMove: () => void;
  onEdit: () => void;
  onCancelAppointment: () => void;
}) {
  const info = meta[appointment.id];

  return (
    <div className={styles.detail}>
      <div className={styles.detailRows}>
        <span className={styles.detailKey}>Clienta</span>
        <span className={styles.detailValue}>{info?.customer ?? "Sin clienta"}</span>

        {info?.phone ? (
          <>
            <span className={styles.detailKey}>Teléfono</span>
            <span className={styles.detailValue}>
              <a href={`tel:${info.phone}`}>{formatPhoneCO(info.phone)}</a>
            </span>
          </>
        ) : null}

        <span className={styles.detailKey}>Servicio</span>
        <span className={styles.detailValue}>{info?.service ?? "Sin servicio"}</span>

        <span className={styles.detailKey}>Cuándo</span>
        <span className={styles.detailValue}>
          {formatDateLong(appointment.start)} · {formatTimeRange(appointment.start, appointment.end)}
        </span>

        <span className={styles.detailKey}>Estado</span>
        <span className={styles.detailValue}>
          <StatusPill status={appointment.status} size="sm" />
        </span>

        {appointment.notes ? (
          <>
            <span className={styles.detailKey}>Notas</span>
            <span className={styles.detailValue}>{appointment.notes}</span>
          </>
        ) : null}
      </div>

      {!readOnly ? (
        <div className={styles.formRow}>
          <Button variant="primary" onClick={onEdit} block>
            Editar
          </Button>
          <Button onClick={onMove} disabled={moving} block>
            Mover
          </Button>
          <Button variant="danger" onClick={onCancelAppointment} block>
            Cancelar cita
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// El reloj
// ---------------------------------------------------------------------------

/** Se suscribe al minuto. Ver `useNow()`. */
function subscribeToMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

/** Minuto actual desde la época. Estable dentro del mismo minuto. */
function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * "Ahora", redondeado al minuto, y `null` en el servidor.
 *
 * El reloj es un sistema externo, no estado de React, y por eso va con
 * `useSyncExternalStore` y no con un `useEffect` que llame a `setState`: la
 * versión con efecto produce un render en cascada en cada montaje y React lo
 * marca como tal.
 *
 * El `null` del servidor es deliberado: renderizar la línea de "ahora" en el
 * servidor la dibujaría a la hora del proceso —que puede estar en otra zona— y
 * la haría saltar al hidratar. Sin línea hasta que el navegador diga la hora.
 */
function useNow(): Date | null {
  const minute = useSyncExternalStore(subscribeToMinute, currentMinute, () => null);
  return minute === null ? null : new Date(minute * 60_000);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function lengthMinutes(appointment: Appointment): number {
  const from = toMinutes(appointment.start);
  const till = toMinutes(appointment.end);
  const sameDay = appointment.start.slice(0, 10) === appointment.end.slice(0, 10);
  // Una cita que cruza la medianoche conserva su duración sumando el día. No es
  // el caso de este estudio, pero mover una y que se acorte a −600 minutos sí
  // sería un dato destruido.
  return sameDay ? till - from : till + 24 * 60 - from;
}

function toMinutes(wall: string): number {
  return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}

function atMinute(date: EaLocalDate, minute: number): EaLocalDateTime {
  return `${date} ${hhmm(minute)}:00` as EaLocalDateTime;
}

function hhmm(minute: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minute)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/** Identidad de un borrador: la cita, o el hueco desde el que se abrió. */
function formKey(draft: AppointmentDraft): string {
  return draft.id !== undefined
    ? `cita-${draft.id}`
    : `nueva-${draft.providerId}-${draft.date}-${draft.startTime}`;
}

function draftFrom(appointment: Appointment, meta: AgendaData["meta"]): AppointmentDraft {
  return {
    id: appointment.id,
    providerId: appointment.providerId ?? 0,
    serviceId: appointment.serviceId,
    customerId: appointment.customerId,
    customerName: meta[appointment.id]?.customer ?? null,
    date: appointment.start.slice(0, 10),
    startTime: appointment.start.slice(11, 16),
    endTime: appointment.end.slice(11, 16),
    notes: appointment.notes ?? "",
    status: appointment.status,
  };
}
