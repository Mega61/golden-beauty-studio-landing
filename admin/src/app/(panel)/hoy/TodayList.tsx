"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  Button,
  EmptyState,
  Icon,
  StatusPill,
  formatCOP,
  formatTimeRange,
  useToast,
} from "@/components/ui";
import { WhatsAppLink } from "@/components/ui/WhatsAppLink";
import {
  CambioTag,
  TicketSheet,
  draftFromFinance,
  emptyDraft,
  isDirty,
  promoDateOf,
  useTicketOutbox,
  type CloseTicketAction,
  type FirstVisitCheck,
  type FirstVisitStatus,
  type PendingTicket,
  type TicketCatalog,
  type TicketDraft,
  type TodayAppointment,
} from "@/components/ticket";
import { mapEaStatus } from "@/components/calendar/status-map";
import { AttendanceControl } from "./AttendanceControl";
import type { ComboComposition } from "@/lib/combos";

/**
 * La lista del día y la orquestación de la cuenta.
 *
 * Es el componente cliente de la pantalla **Hoy**. Tiene tres trabajos y
 * ninguno más:
 *
 * 1. Dibujar una tarjeta por cita, con su acción primaria.
 * 2. Sostener el borrador de la cuenta que está abierta, y guardarlo en cada
 *    tecla.
 * 3. Hablar con la cola de envíos (`useTicketOutbox`) y decir en pantalla lo
 *    que la cola sabe.
 *
 * **El borrador vive acá y no en la hoja** porque la hoja se desmonta al
 * cerrarse, y lo que tiene que sobrevivir a que se cierre no puede pertenecerle.
 * Además esta lista es la que ve todas las cuentas del día: es el único lugar
 * desde donde tiene sentido mostrar "dos cuentas pendientes de sincronizar".
 *
 * La lista es de tarjetas y no una `DataTable`. A 390 px `visibleColumns()`
 * devuelve cero columnas a propósito (A3), y aunque colapsara a lista de dos
 * líneas, cada fila de acá lleva estado, monto, marca de cambio y una acción
 * primaria de 44 px — es una tarjeta, no una celda.
 */
export function TodayList({
  appointments,
  catalog,
  scope,
  canCharge,
  canGiveCourtesy = false,
  canSeeTotals,
  canFixAfterClose,
  readOnly,
  action,
  combos = [],
  checkFirstVisit,
}: {
  appointments: readonly TodayAppointment[];
  catalog: TicketCatalog;
  /** Id de la sesión: separa los borradores en una tablet compartida. */
  scope: string;
  canCharge: boolean;
  /** `cortesia:otorgar`: solo la dueña marca una cortesía de la casa. */
  canGiveCourtesy?: boolean;
  canSeeTotals: boolean;
  canFixAfterClose: boolean;
  /** EA no responde: se puede mirar, no guardar. */
  readOnly: boolean;
  action: CloseTicketAction;
  /** Los combos, para ofrecer "¿también pies?" al cerrar. */
  combos?: readonly ComboComposition[];
  /** La pregunta "¿es su primera visita?" (Server Action). Sin ella, no se pregunta. */
  checkFirstVisit?: FirstVisitCheck;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState<TicketDraft | null>(null);
  const [baseline, setBaseline] = useState<TicketDraft | null>(null);
  const [saving, setSaving] = useState(false);
  // Lo que dijo el historial de la cuenta abierta. Se pregunta al abrirla, no
  // al cargar el día: son varias lecturas a EA por clienta.
  const [firstVisit, setFirstVisit] = useState<{
    id: number;
    status: FirstVisitStatus | "pendiente";
  } | null>(null);

  const outbox = useTicketOutbox({
    scope,
    action,
    // Cuando la cola logra mandar algo en segundo plano —el wifi volvió— la
    // pantalla tiene que enterarse: los datos vienen del servidor y la tarjeta
    // sigue diciendo "sin cuenta" hasta que se vuelvan a pedir.
    onSaved: () => router.refresh(),
  });

  const byId = useMemo(
    () => new Map(appointments.map((a) => [a.eaAppointmentId, a])),
    [appointments],
  );

  const open = useCallback(
    (appointment: TodayAppointment) => {
      const guardado = draftFromFinance(
        appointment.eaAppointmentId,
        appointment.bookedServiceId,
        appointment.finance,
      );
      // Una cuenta nueva de una clienta marcada "cortesía de la casa por
      // defecto" arranca con la casilla marcada — solo si quien abre la hoja la
      // puede otorgar. Una cuenta ya guardada manda lo que se guardó: la marca
      // de la ficha no reescribe una decisión que alguien ya tomó.
      const nueva =
        appointment.finance.financeId === null || appointment.finance.items.length === 0;
      const base =
        nueva
          ? emptyDraft(
              appointment.eaAppointmentId,
              appointment.bookedServiceId,
              Date.now(),
              canGiveCourtesy && appointment.houseCourtesyDefault,
            )
          : guardado;

      // Lo que quedó escrito en el celular gana sobre lo que hay en la base:
      // es más nuevo, y es exactamente lo que esta pantalla existe para no
      // perder.
      const local = outbox.restore(appointment.eaAppointmentId);

      setBaseline(base);
      setDraft(local ?? base);
      setOpenId(appointment.eaAppointmentId);
      setFirstVisit(null);

      // ¿Primera visita? Solo en una cuenta nueva: una ya guardada trae lo que
      // se decidió al cerrarla. La respuesta llega después de abrir la hoja; si
      // es "sí" y la casilla sigue como arrancó, se marca — en el borrador y en
      // la línea base, porque no es un cambio que alguien hizo. Un borrador
      // restaurado del celular no se toca: ahí la técnica ya decidió.
      if (nueva && checkFirstVisit !== undefined && !readOnly) {
        const id = appointment.eaAppointmentId;
        setFirstVisit({ id, status: "pendiente" });
        checkFirstVisit(id)
          .catch((): FirstVisitStatus => "desconocido")
          .then((status) => {
            setFirstVisit((cur) => (cur?.id === id ? { id, status } : cur));
            if (status !== "primera" || local !== null) return;
            setDraft((d) =>
              d !== null && d.eaAppointmentId === id && !d.firstVisit ? { ...d, firstVisit: true } : d,
            );
            setBaseline((b) =>
              b !== null && b.eaAppointmentId === id ? { ...b, firstVisit: true } : b,
            );
          });
      }
    },
    [outbox, canGiveCourtesy, checkFirstVisit, readOnly],
  );

  const change = useCallback(
    (next: TicketDraft) => {
      setDraft(next);
      outbox.keep(next);
    },
    [outbox],
  );

  const close = useCallback(() => {
    setOpenId(null);
    setDraft(null);
    setBaseline(null);
  }, []);

  const save = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    const outcome = await outbox.submit(draft);
    setSaving(false);

    if (outcome.status === "ok") {
      toast({ message: "Cuenta guardada", tone: "ok" });
      close();
      router.refresh();
      return;
    }

    if (outcome.status === "rechazado") {
      // No se cierra la hoja: hay algo que corregir y lo escrito sigue ahí.
      toast({ message: outcome.message, tone: "error" });
      return;
    }

    toast({
      message: "Sin conexión. La cuenta quedó guardada acá y se manda sola.",
      tone: "warn",
    });
    close();
  }, [draft, outbox, toast, close, router]);

  const current = openId === null ? null : (byId.get(openId) ?? null);
  const pendientes = outbox.pending.size;

  if (appointments.length === 0) {
    return (
      <EmptyState
        icon="hoy"
        title="Todavía no hay citas hoy"
        body="Cuando la agenda tenga una cita de hoy, va a aparecer acá con su botón para cerrar la cuenta."
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      {pendientes > 0 ? (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.625rem 0.75rem",
            borderRadius: "var(--radius-md)",
            background: "var(--color-warn-tint)",
            border: "1px solid var(--color-warn-line)",
            color: "var(--color-warn-ink)",
            fontSize: "var(--text-xs)",
          }}
        >
          <Icon name="alerta" size={16} style={{ flex: "none" }} />
          <span style={{ flex: 1 }}>
            {pendientes === 1
              ? "1 cuenta pendiente de sincronizar."
              : `${pendientes} cuentas pendientes de sincronizar.`}{" "}
            {outbox.online ? "Se reintenta sola." : "Sin conexión."}
          </span>
        </div>
      ) : null}

      {appointments.map((appointment) => (
        <AppointmentCard
          key={appointment.eaAppointmentId}
          appointment={appointment}
          pending={outbox.pending.get(appointment.eaAppointmentId) ?? null}
          canSeeTotals={canSeeTotals}
          canFixAfterClose={canFixAfterClose}
          readOnly={readOnly}
          onOpen={() => open(appointment)}
          onRetry={() => void outbox.retry(appointment.eaAppointmentId)}
          onAttendance={(outcome) => {
            router.refresh();
            // "Llegó" sin cuenta todavía: lo siguiente que la técnica va a hacer
            // es cerrarla, así que la hoja se abre sola.
            if (outcome.mark === "llego" && appointment.finance.closedAt === null) open(appointment);
          }}
        />
      ))}

      {current !== null && draft !== null && baseline !== null ? (
        <TicketSheet
          open
          appointment={current}
          catalog={catalog}
          draft={draft}
          pricing={{
            bookedServiceId: current.bookedServiceId,
            bookedSnapshot: current.finance.snapshot,
            promoDate: promoDateOf(current.start),
          }}
          combos={combos}
          firstVisitStatus={firstVisit?.id === current.eaAppointmentId ? firstVisit.status : null}
          canCharge={canCharge}
          canGiveCourtesy={canGiveCourtesy}
          courtesyFromDefault={current.houseCourtesyDefault && current.finance.closedAt === null}
          readOnly={readOnly || (current.finance.frozenByDayClose && !canFixAfterClose)}
          saving={saving}
          dirty={isDirty(draft, baseline)}
          pending={outbox.pending.get(current.eaAppointmentId) ?? null}
          storageBlocked={outbox.storageBlocked}
          onDraftChange={change}
          onClose={close}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}

function AppointmentCard({
  appointment,
  pending,
  canSeeTotals,
  canFixAfterClose,
  readOnly,
  onOpen,
  onRetry,
  onAttendance,
}: {
  appointment: TodayAppointment;
  pending: PendingTicket | null;
  canSeeTotals: boolean;
  canFixAfterClose: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onRetry: () => void;
  onAttendance: (outcome: { mark: "llego" | "no-asistio" | "deshacer" }) => void;
}) {
  const { finance } = appointment;
  const cerrada = finance.closedAt !== null;
  const cambio =
    finance.performedServiceId !== null &&
    appointment.bookedServiceId !== null &&
    finance.performedServiceId !== appointment.bookedServiceId;
  const congelada = finance.frozenByDayClose && !canFixAfterClose;

  return (
    <article
      className="ui-card"
      style={{ display: "grid", gap: "0.625rem", padding: "0.875rem" }}
    >
      <header style={{ display: "flex", alignItems: "flex-start", gap: "0.625rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            className="ui-num"
            style={{
              margin: 0,
              fontSize: "var(--text-2xs)",
              color: "var(--color-ink-soft)",
            }}
          >
            {formatTimeRange(appointment.start, appointment.end)} · {appointment.providerName}
          </p>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: "var(--color-carbon)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {appointment.customerName}
          </h3>
          <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>
            {appointment.bookedServiceName}
          </p>
          {/* Para avisar que la técnica se atrasó o preguntar si ya viene,
              sin salir de Hoy a buscar el número. */}
          {appointment.customerPhone ? (
            <div style={{ marginTop: "0.375rem" }}>
              <WhatsAppLink
                phone={appointment.customerPhone}
                customerName={appointment.customerName}
              />
            </div>
          ) : null}
        </div>
        {appointment.status === "" ? null : (
          <StatusPill status={mapEaStatus(appointment.status)} size="sm" />
        )}
      </header>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
          minHeight: "1.5rem",
        }}
      >
        {pending !== null ? (
          <>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3125rem",
                padding: "0.125rem 0.4375rem",
                borderRadius: "999px",
                background: "var(--color-warn-tint)",
                border: "1px solid var(--color-warn-line)",
                color: "var(--color-warn-ink)",
                fontSize: "var(--text-2xs)",
                fontWeight: 600,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--color-warn-ink)",
                }}
              />
              pendiente de sincronizar
            </span>
            <Button variant="ghost" icon="deshacer" onClick={onRetry}>
              Reintentar
            </Button>
          </>
        ) : cerrada ? (
          <>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3125rem",
                fontSize: "var(--text-2xs)",
                fontWeight: 600,
                color: "var(--color-st-completada-ink)",
              }}
            >
              <Icon name="check" size={14} /> cuenta cerrada
            </span>
            {finance.houseCourtesy ? (
              <span style={{ fontSize: "var(--text-2xs)", fontWeight: 600, color: "var(--color-info-ink)" }}>
                cortesía de la casa
              </span>
            ) : canSeeTotals && finance.amountCharged !== null ? (
              <span className="ui-num" style={{ fontWeight: 600 }}>
                {formatCOP(finance.amountCharged)}
              </span>
            ) : null}
            {cambio ? <CambioTag /> : null}
          </>
        ) : (
          <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            sin cuenta
          </span>
        )}
      </div>

      <AttendanceControl
        eaAppointmentId={appointment.eaAppointmentId}
        start={appointment.start}
        status={appointment.status}
        closed={cerrada}
        readOnly={readOnly}
        onMarked={onAttendance}
      />

      <Button
        variant={cerrada || pending !== null ? "secondary" : "primary"}
        block
        onClick={onOpen}
        icon={cerrada ? undefined : "caja"}
      >
        {readOnly || congelada ? "Ver cuenta" : cerrada ? "Editar cuenta" : "Cerrar servicio"}
      </Button>
    </article>
  );
}
