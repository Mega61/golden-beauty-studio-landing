"use client";

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";

import { ConflictReview } from "@/components/calendar";
import type { MetaIndex, ProviderOption, ServiceOption } from "@/components/calendar/types";
import styles from "@/components/calendar/calendar.module.css";
import { Button } from "@/components/ui/Button";
import { Field, Select, TextArea, TextInput } from "@/components/ui/Field";
import { formatDuration, formatPhoneCO } from "@/components/ui/format";
import { STATUS_IDS, STATUS_META } from "@/components/ui/status";
import type { ConflictReport } from "@/lib/conflict";
import { findCustomers } from "./actions";

/**
 * El formulario de la cita: crear, mover, editar.
 *
 * Es el "modal de cita" de EA reconstruido (§ Paridad con EA), con dos
 * diferencias que importan:
 *
 * - **La clienta se busca por nombre o teléfono, y se elige de una lista.** No
 *   hay campo de correo: la identidad de la clienta en este proyecto es el
 *   teléfono en E.164 y el flujo viejo inventaba direcciones. Crear clientas es
 *   de C4; acá solo se eligen.
 * - **El fin se deriva de la duración del servicio** y se puede corregir a mano.
 *   Escribir dos horas para cada cita es el trabajo que la agenda existe para
 *   ahorrar.
 *
 * El chequeo de choques no está acá: lo hace el servidor al enviar, contra datos
 * frescos, y si hay algo devuelve el reporte para que este formulario lo muestre
 * y reofrezca con "Guardar de todas formas".
 */

export type AppointmentDraft = {
  id?: number;
  providerId: number;
  serviceId: number | null;
  customerId: number | null;
  customerName: string | null;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  startTime: string;
  endTime: string;
  notes: string;
  status: string;
};

export type AppointmentFormProps = {
  draft: AppointmentDraft;
  providers: readonly ProviderOption[];
  services: readonly ServiceOption[];
  meta: MetaIndex;
  /** El reporte que devolvió el último envío, si lo hubo. */
  report: ConflictReport | null;
  error: string | null;
  saving: boolean;
  onSubmit: (draft: AppointmentDraft, force: boolean) => void;
  onCancel: () => void;
};

export function AppointmentForm({
  draft: initial,
  providers,
  services,
  meta,
  report,
  error,
  saving,
  onSubmit,
  onCancel,
}: AppointmentFormProps) {
  // El borrador arranca del que llega y a partir de ahí es estado interno. **No
  // se sincroniza con un efecto**: cuando cambia la cita que se edita, el padre
  // remonta el formulario con una `key` distinta. Un efecto que copiara la prop
  // al estado produciría un render en cascada en cada apertura.
  const [draft, setDraft] = useState<AppointmentDraft>(initial);
  const errorRef = useRef<HTMLDivElement>(null);

  // El resumen de error recibe el foco al aparecer: en un celular, quien envía
  // no ve la mitad del formulario y el mensaje quedaría fuera de pantalla.
  useEffect(() => {
    if (error || report) errorRef.current?.focus();
  }, [error, report]);

  const set = <K extends keyof AppointmentDraft>(key: K, value: AppointmentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const service = services.find((s) => s.id === draft.serviceId) ?? null;

  /** Al elegir servicio, el fin se recalcula con su duración. */
  const pickService = (id: number | null) => {
    const chosen = services.find((s) => s.id === id) ?? null;
    setDraft((current) => ({
      ...current,
      serviceId: id,
      endTime: chosen?.duration
        ? addMinutesToTime(current.startTime, chosen.duration)
        : current.endTime,
    }));
  };

  /** Al correr el inicio, el fin se corre igual: la duración es lo que se pactó. */
  const pickStart = (value: string) => {
    setDraft((current) => {
      const length = minutesBetweenTimes(current.startTime, current.endTime);
      return {
        ...current,
        startTime: value,
        endTime: length > 0 ? addMinutesToTime(value, length) : current.endTime,
      };
    });
  };

  const length = minutesBetweenTimes(draft.startTime, draft.endTime);
  const incomplete = draft.customerId === null || draft.serviceId === null || length <= 0;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!incomplete) onSubmit(draft, false);
      }}
    >
      {error || report ? (
        <div ref={errorRef} tabIndex={-1}>
          {error ? (
            <div className={styles.conflictItem + " " + styles.conflictHard}>
              <p className={styles.conflictHead}>{error}</p>
            </div>
          ) : null}
          {report ? (
            <ConflictReview report={report} providers={providers} meta={meta} />
          ) : null}
        </div>
      ) : null}

      <CustomerPicker
        customerId={draft.customerId}
        customerName={draft.customerName}
        onPick={(customer) =>
          setDraft((current) => ({
            ...current,
            customerId: customer?.id ?? null,
            customerName: customer?.name ?? null,
          }))
        }
      />

      <Field label="Servicio" required>
        {(wired) => (
          <Select
            {...wired}
            value={draft.serviceId ?? ""}
            onChange={(e) => pickService(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">Elegí un servicio…</option>
            {services.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
                {option.duration ? ` · ${formatDuration(option.duration)}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Profesional" required>
        {(wired) => (
          <Select
            {...wired}
            value={draft.providerId}
            onChange={(e) => set("providerId", Number(e.target.value))}
          >
            {providers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Field label="Fecha" required>
          {(wired) => (
            <TextInput
              {...wired}
              type="date"
              value={draft.date}
              onChange={(e) => set("date", e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Empieza"
          required
          hint={length > 0 ? `Dura ${formatDuration(length)}` : undefined}
        >
          {(wired) => (
            <TextInput
              {...wired}
              type="time"
              step={300}
              value={draft.startTime}
              onChange={(e) => pickStart(e.target.value)}
            />
          )}
        </Field>
      </div>

      <div className={`${styles.formRow} ${styles.formRow2}`}>
        <Field
          label="Termina"
          required
          error={length <= 0 ? "Tiene que ser después de que empieza." : undefined}
        >
          {(wired) => (
            <TextInput
              {...wired}
              type="time"
              step={300}
              value={draft.endTime}
              onChange={(e) => set("endTime", e.target.value)}
            />
          )}
        </Field>

        {draft.id !== undefined ? (
          <Field label="Estado">
            {(wired) => (
              <Select
                {...wired}
                value={draft.status}
                onChange={(e) => set("status", e.target.value)}
              >
                {/* Las etiquetas del panel son las que `docs/DEV-LOCAL.md`
                    manda configurar en EA. Si alguien renombró la lista allá,
                    la cita se guarda con la cadena que se elija acá y el mapa
                    de estados la dibujará punteada — que es la señal correcta,
                    no un crash. */}
                {STATUS_IDS.map((id) => (
                  <option key={id} value={STATUS_META[id].label}>
                    {STATUS_META[id].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      <Field
        label="Notas"
        hint="Las ve la técnica en su agenda. No es la cuenta del servicio."
      >
        {(wired) => (
          <TextArea
            {...wired}
            rows={2}
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        )}
      </Field>

      {service?.attendantsNumber && service.attendantsNumber > 1 ? (
        <p className={styles.formPreview}>
          Este servicio admite {service.attendantsNumber} clientas a la vez con la misma
          profesional.
        </p>
      ) : null}

      <div className={styles.formRow}>
        {report && !report.ok ? (
          // Las dos severidades se pueden forzar: es el mismo modelo mental del
          // `force_save` de EA. Lo que cambia es el tono, no la existencia del
          // botón.
          <Button
            variant={report.hard ? "danger" : "primary"}
            loading={saving}
            onClick={() => onSubmit(draft, true)}
            block
          >
            Guardar de todas formas
          </Button>
        ) : (
          <Button type="submit" variant="primary" loading={saving} disabled={incomplete} block>
            {draft.id === undefined ? "Crear cita" : "Guardar cambios"}
          </Button>
        )}
        <Button variant="ghost" onClick={onCancel} block>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Buscador de clientas
// ---------------------------------------------------------------------------

type Found = { id: number; name: string; phone: string | null };

/**
 * Buscar por nombre o teléfono y elegir de la lista.
 *
 * Se dispara a partir de dos letras y con un respiro de 300 ms: la búsqueda de
 * EA usa `q`, que **anula todos los demás filtros**, así que cada tecleo es una
 * consulta completa a su base.
 */
function CustomerPicker({
  customerId,
  customerName,
  onPick,
}: {
  customerId: number | null;
  customerName: string | null;
  onPick: (customer: Found | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [, startSearch] = useTransition();
  const listId = useId();

  const trimmed = term.trim();
  // Se **deriva** en vez de guardarse: con la clienta ya elegida, o con menos de
  // dos letras, no hay lista que mostrar, y borrar el estado desde el efecto
  // sería un render en cascada por tecla.
  const shown = customerId === null && trimmed.length >= 2 ? results : [];

  useEffect(() => {
    if (customerId !== null || trimmed.length < 2) return;

    const timer = setTimeout(() => {
      startSearch(async () => {
        try {
          setResults(await findCustomers(trimmed));
        } catch {
          // Una búsqueda que falla deja la lista vacía y el campo utilizable.
          // La cita se puede seguir armando; lo que no se puede es dejar el
          // formulario colgado por una consulta auxiliar.
          setResults([]);
        }
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [trimmed, customerId]);

  const chosen = useMemo(
    () => (customerId !== null ? { id: customerId, name: customerName ?? "" } : null),
    [customerId, customerName],
  );

  if (chosen) {
    return (
      <Field label="Clienta" required>
        {() => (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ flex: 1, fontWeight: 600 }}>{chosen.name}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTerm("");
                onPick(null);
              }}
            >
              Cambiar
            </Button>
          </div>
        )}
      </Field>
    );
  }

  return (
    <Field label="Clienta" required hint="Buscá por nombre o teléfono.">
      {(wired) => (
        <>
          <TextInput
            {...wired}
            value={term}
            placeholder="Marcela, 300…"
            autoComplete="off"
            aria-controls={listId}
            aria-expanded={shown.length > 0}
            onChange={(e) => setTerm(e.target.value)}
          />
          {shown.length > 0 ? (
            <ul id={listId} className="ui-list" style={{ marginTop: "0.375rem" }}>
              {shown.map((found) => (
                <li key={found.id}>
                  <button
                    type="button"
                    className="ui-list__row"
                    data-interactive="true"
                    style={{ width: "100%", border: 0, background: "none", font: "inherit" }}
                    onClick={() => onPick(found)}
                  >
                    <span className="ui-list__body">
                      <span className="ui-list__primary">{found.name}</span>
                      <span className="ui-list__secondary">
                        {found.phone ? formatPhoneCO(found.phone) : "Sin teléfono"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Horas
// ---------------------------------------------------------------------------

/**
 * `"14:00"` + 90 → `"15:30"`.
 *
 * Aritmética sobre minutos de reloj, no sobre un `Date`: la hora de pared es el
 * tipo canónico de este proyecto y construir una fecha para sumarle minutos es
 * cómo se cuela el bug de cinco horas. Pasadas las 24 h se queda en 23:59: una
 * cita que cruza la medianoche se escribe cambiando la fecha, no dejando que un
 * campo de hora desborde en silencio.
 */
function addMinutesToTime(time: string, minutes: number): string {
  const total = toMinutes(time);
  if (total === null) return time;
  const next = Math.min(23 * 60 + 59, total + minutes);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

function minutesBetweenTimes(from: string, till: string): number {
  const a = toMinutes(from);
  const b = toMinutes(till);
  if (a === null || b === null) return 0;
  return b - a;
}

function toMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
