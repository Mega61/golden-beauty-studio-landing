"use client";

import { useId, useMemo, useState, type ReactNode } from "react";

import {
  Button,
  Field,
  FormErrorSummary,
  Icon,
  MoneyInput,
  Panel,
  TextArea,
  formatCOP,
  formatTimeRange,
} from "@/components/ui";
import type { PaymentMethod } from "@/db/types";
import { ExtrasChips } from "./ExtrasChips";
import { CambioTag, ServicePicker } from "./ServicePicker";
import type { TicketCatalog } from "./catalog";
import {
  NOTE_CHIPS,
  PAYMENT_METHODS,
  VARIANCE_REASONS,
  appendNoteChip,
  bumpExtra,
  priceDraft,
  type TicketDraft,
  type TicketPricing,
} from "./draft";
import type { PendingTicket } from "./draft-store";
import type { TodayAppointment } from "./types";

/**
 * **Cerrar servicio** — la pantalla diseñada para un celular en una mano, entre
 * dos clientas. El escritorio es el caso raro, y por eso todo acá está pensado
 * a 390 px primero.
 *
 * Los seis pasos del plan, en orden, cada uno una sección con su número:
 *
 * 1. ¿Qué se hizo? — el agendado ya viene elegido
 * 2. Adicionales — chips con contador
 * 3. Total — grande, calculado; tocarlo lo hace editable y abre el motivo
 * 4. Observaciones — libres, con chips de arranque
 * 5. Cobro — método (si tiene permiso) y propina, aparte
 * 6. Guardar
 *
 * ## Lo que este componente no hace
 *
 * **No calcula plata.** Ni una suma. Todo número que se pinta acá sale de
 * `priceDraft()`, que es un envoltorio delgado sobre `lib/ticket.ts`. Si hiciera
 * falta un cálculo que no existe, el lugar de agregarlo es `lib/`, no un
 * `useMemo`.
 *
 * **No decide permisos.** `canCharge` y `readOnly` llegan resueltos desde el
 * servidor, y volver a comprobarlos en la Server Action no es redundancia sino
 * el diseño: esconder el paso 5 es cortesía con la usuaria, y la compuerta está
 * en el DAL.
 *
 * **No persiste.** El borrador lo guarda el padre (`TodayList`), que es quien
 * ve todas las cuentas del día y puede reintentar las que quedaron en cola. Un
 * componente que se desmonta al cerrarse no puede ser el dueño de algo que
 * tiene que sobrevivir a que se cierre.
 *
 * ## La hoja no se cierra sola con cambios adentro
 *
 * `dismissable` se apaga en cuanto hay algo escrito: tocar el fondo con el
 * pulgar es el gesto más fácil de hacer sin querer en un celular, y perder una
 * cuenta a medio armar por eso sería exactamente el problema que el borrador
 * local vino a resolver.
 */
export function TicketSheet({
  open,
  appointment,
  catalog,
  draft,
  pricing,
  canCharge,
  readOnly = false,
  saving = false,
  dirty,
  pending,
  storageBlocked = false,
  onDraftChange,
  onClose,
  onSave,
}: {
  open: boolean;
  appointment: TodayAppointment;
  catalog: TicketCatalog;
  draft: TicketDraft;
  pricing: TicketPricing;
  /** `TICKET_STAFF_COBRA` ya resuelto contra el rol. Ver `lib/auth-policy.ts`. */
  canCharge: boolean;
  readOnly?: boolean;
  saving?: boolean;
  dirty: boolean;
  pending: PendingTicket | null;
  /** El navegador no deja escribir en `localStorage`. Se avisa, no se esconde. */
  storageBlocked?: boolean;
  onDraftChange: (next: TicketDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const errorsId = useId();
  const [showTotalEditor, setShowTotalEditor] = useState(false);
  const [showManual, setShowManual] = useState(draft.manual !== null);

  const pricingResult = useMemo(
    () => priceDraft(draft, catalog, pricing),
    [draft, catalog, pricing],
  );

  const editandoTotal = showTotalEditor || draft.totalOverride !== null;
  const amountCharged = pricingResult.totals?.amountCharged ?? null;
  const subtotal = pricingResult.subtotal;
  const descuento = pricingResult.totals?.discount ?? 0;
  const cambioServicio =
    draft.performedServiceId !== null &&
    appointment.bookedServiceId !== null &&
    draft.performedServiceId !== appointment.bookedServiceId;

  const bloqueado = readOnly || saving;
  const puedeGuardar = !bloqueado && pricingResult.errors.length === 0;

  function patch(next: Partial<TicketDraft>): void {
    onDraftChange({ ...draft, ...next, updatedAt: Date.now() });
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Cerrar servicio"
      dismissable={!dirty}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {dirty ? "Seguir después" : "Cerrar"}
          </Button>
          <Button
            variant="primary"
            block
            loading={saving}
            loadingLabel="Guardando"
            disabled={!puedeGuardar}
            onClick={onSave}
          >
            {amountCharged === null ? "Guardar" : `Guardar · ${formatCOP(amountCharged)}`}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: "1.25rem" }}>
        <Encabezado appointment={appointment} />

        {pending !== null ? <PendienteAviso pending={pending} /> : null}

        {storageBlocked ? (
          <Aviso tono="warn">
            Este navegador no deja guardar borradores. Si se cae el wifi antes de guardar, lo
            escrito se pierde: termina la cuenta antes de cambiar de pantalla.
          </Aviso>
        ) : null}

        {readOnly ? (
          <Aviso tono="warn">
            La cuenta ya entró al cierre del día. Corregirla exige un ajuste y lo hace la dueña.
          </Aviso>
        ) : null}

        {pricingResult.errors.length > 0 ? (
          <FormErrorSummary
            errors={pricingResult.errors.map((message, i) => ({
              id: `${errorsId}-${i}`,
              message,
            }))}
          />
        ) : null}

        <Paso n={1} titulo="¿Qué se hizo?">
          <ServicePicker
            catalog={catalog}
            value={draft.performedServiceId}
            bookedServiceId={appointment.bookedServiceId}
            disabled={bloqueado}
            onChange={(eaServiceId) => patch({ performedServiceId: eaServiceId })}
          />
          {cambioServicio ? (
            <p
              style={{
                margin: 0,
                fontSize: "var(--text-2xs)",
                color: "var(--color-ink-soft)",
              }}
            >
              Se agendó <strong>{appointment.bookedServiceName}</strong>. La cita en la agenda no
              se reescribe: EA guarda la reserva, el panel guarda lo que se hizo.
            </p>
          ) : null}
        </Paso>

        <Paso n={2} titulo="Adicionales">
          <ExtrasChips
            catalog={catalog}
            quantities={draft.extras}
            disabled={bloqueado}
            onChange={(eaServiceId, delta) => onDraftChange(bumpExtra(draft, eaServiceId, delta))}
          />

          {showManual || draft.manual !== null ? (
            <RenglonManual
              value={draft.manual}
              disabled={bloqueado}
              onChange={(manual) => patch({ manual })}
              onRemove={() => {
                setShowManual(false);
                patch({ manual: null });
              }}
            />
          ) : (
            <button
              type="button"
              className="ui-btn ui-btn--ghost"
              disabled={bloqueado}
              onClick={() => {
                setShowManual(true);
                patch({ manual: { note: "", amount: 0 } });
              }}
              style={{ justifySelf: "start" }}
            >
              <Icon name="mas-signo" size={16} /> Otro cobro (fuera del catálogo)
            </button>
          )}
        </Paso>

        <Paso n={3} titulo="Total">
          <TotalBlock
            subtotal={subtotal}
            amountCharged={amountCharged}
            descuento={descuento}
            editando={editandoTotal}
            disabled={bloqueado}
            onEditar={() => {
              setShowTotalEditor(true);
              if (draft.totalOverride === null && amountCharged !== null) {
                patch({ totalOverride: amountCharged });
              }
            }}
            onValor={(pesos) => patch({ totalOverride: pesos })}
            onVolverAlCalculado={() => {
              setShowTotalEditor(false);
              patch({ totalOverride: null, varianceReasonCode: null, varianceReason: "" });
            }}
            valor={draft.totalOverride}
          />

          {editandoTotal ? (
            <MotivoBlock
              code={draft.varianceReasonCode}
              text={draft.varianceReason}
              exigido={descuento > 0}
              disabled={bloqueado}
              onCode={(varianceReasonCode) => patch({ varianceReasonCode })}
              onText={(varianceReason) => patch({ varianceReason })}
            />
          ) : null}

          {pricingResult.flags.length > 0 ? (
            <Aviso tono="warn">
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {pricingResult.flags.map((f) => (
                  <li key={`${f.label}-${f.message}`}>
                    <strong>{f.label}</strong>: {f.message}
                  </li>
                ))}
              </ul>
            </Aviso>
          ) : null}
        </Paso>

        <Paso n={4} titulo="Observaciones">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
            {NOTE_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="ui-btn ui-btn--secondary"
                disabled={bloqueado}
                onClick={() => patch({ notes: appendNoteChip(draft.notes, chip) })}
              >
                {chip}
              </button>
            ))}
          </div>

          <Field label="Qué pasó" hint="Se guarda en el panel y aparece en la ficha de la clienta.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                describedBy={describedBy}
                rows={3}
                value={draft.notes}
                disabled={bloqueado}
                placeholder="Se le rompió una y se repuso sin cobro."
                onChange={(e) => patch({ notes: e.target.value })}
              />
            )}
          </Field>

          <p
            style={{
              margin: 0,
              display: "flex",
              gap: "0.375rem",
              fontSize: "var(--text-2xs)",
              color: "var(--color-ink-soft)",
            }}
          >
            <Icon name="candado" size={14} style={{ flex: "none", marginTop: 2 }} />
            <span>
              Esto <strong>no</strong> se copia a las notas de la cita en EA. Las notas de EA viajan
              al evento de Google, que está compartido a un correo personal.
            </span>
          </p>
        </Paso>

        <Paso n={5} titulo="Cobro">
          {canCharge ? (
            <MetodoPago
              value={draft.paymentMethod}
              disabled={bloqueado}
              onChange={(paymentMethod) => patch({ paymentMethod })}
            />
          ) : (
            <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>
              El método de pago lo registra recepción. Guarda la cuenta y listo.
            </p>
          )}

          <MoneyInput
            label="Propina"
            value={draft.tip === 0 ? null : draft.tip}
            disabled={bloqueado}
            max={9_999_999}
            hint="Va aparte: no es ingreso del estudio ni entra a la base de comisión."
            onValueChange={(pesos) => patch({ tip: pesos ?? 0 })}
          />
        </Paso>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

function Encabezado({ appointment }: { appointment: TodayAppointment }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "0.125rem",
        paddingBottom: "0.75rem",
        borderBottom: "1px solid var(--hair)",
      }}
    >
      <strong style={{ fontSize: "var(--text-md)", color: "var(--color-carbon)" }}>
        {appointment.customerName}
      </strong>
      <span className="ui-num" style={{ color: "var(--color-ink-soft)" }}>
        {formatTimeRange(appointment.start, appointment.end)} · {appointment.providerName}
      </span>
    </div>
  );
}

function Paso({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: "0.625rem" }}>
      <h3
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          margin: 0,
          fontSize: "var(--text-md)",
          fontWeight: 600,
          color: "var(--color-carbon)",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "1.5rem",
            height: "1.5rem",
            flex: "none",
            borderRadius: "50%",
            background: "var(--color-cream)",
            border: "1px solid var(--hair-strong)",
            fontSize: "var(--text-2xs)",
            fontWeight: 700,
            color: "var(--color-ink-soft)",
          }}
        >
          {n}
        </span>
        {titulo}
      </h3>
      {children}
    </section>
  );
}

function Aviso({ tono, children }: { tono: "warn" | "info"; children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.625rem 0.75rem",
        borderRadius: "var(--radius-md)",
        background: `var(--color-${tono}-tint)`,
        border: `1px solid var(--color-${tono}-line)`,
        color: `var(--color-${tono}-ink)`,
        fontSize: "var(--text-xs)",
      }}
    >
      <Icon name={tono === "warn" ? "alerta" : "info"} size={16} style={{ flex: "none", marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function PendienteAviso({ pending }: { pending: PendingTicket }) {
  return (
    <Aviso tono="warn">
      Esta cuenta está <strong>pendiente de sincronizar</strong>. Se guardó en el celular y se
      reintenta sola.
      {pending.lastError === null ? null : ` Último intento: ${pending.lastError}`}
    </Aviso>
  );
}

/**
 * Paso 3.
 *
 * La cifra es un `<button>` y no un texto con un lápiz al lado: en un celular
 * el objetivo grande *es* el afordance, y un icono de 16 px al costado de un
 * número de 24 es un blanco que se falla. Debajo va siempre el precio de lista,
 * porque el plan pide que la variación se muestre y no se esconda —
 * "independencia con rastro, no vigilancia".
 */
function TotalBlock({
  subtotal,
  amountCharged,
  descuento,
  editando,
  disabled,
  valor,
  onEditar,
  onValor,
  onVolverAlCalculado,
}: {
  subtotal: number | null;
  amountCharged: number | null;
  descuento: number;
  editando: boolean;
  disabled: boolean;
  valor: number | null;
  onEditar: () => void;
  onValor: (pesos: number | null) => void;
  onVolverAlCalculado: () => void;
}) {
  if (editando) {
    return (
      <div style={{ display: "grid", gap: "0.5rem" }}>
        <MoneyInput
          label="Total cobrado"
          value={valor}
          disabled={disabled}
          max={99_999_999}
          hint={
            subtotal === null
              ? undefined
              : `Precio de lista: ${formatCOP(subtotal)}${
                  descuento > 0 ? ` · ${formatCOP(descuento)} menos` : ""
                }`
          }
          onValueChange={onValor}
        />
        <button
          type="button"
          className="ui-btn ui-btn--ghost"
          disabled={disabled}
          onClick={onVolverAlCalculado}
          style={{ justifySelf: "start" }}
        >
          <Icon name="deshacer" size={14} /> Volver al calculado
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onEditar}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "0.75rem",
        width: "100%",
        minHeight: "var(--hit)",
        padding: "0.625rem 0.875rem",
        textAlign: "left",
        background: "var(--color-cream)",
        border: "1px solid var(--hair-strong)",
        borderRadius: "var(--radius-md)",
        color: "inherit",
        font: "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="ui-num"
        style={{
          fontSize: "var(--text-xl)",
          fontWeight: 700,
          color: "var(--color-carbon)",
        }}
      >
        {amountCharged === null ? "—" : formatCOP(amountCharged)}
      </span>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
        Toca para cambiarlo
      </span>
    </button>
  );
}

/** El motivo. Sin motivo no se guarda un descuento — es un campo, no una auditoría. */
function MotivoBlock({
  code,
  text,
  exigido,
  disabled,
  onCode,
  onText,
}: {
  code: string | null;
  text: string;
  exigido: boolean;
  disabled: boolean;
  onCode: (code: TicketDraft["varianceReasonCode"]) => void;
  onText: (text: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <fieldset style={{ margin: 0, padding: 0, border: 0, display: "grid", gap: "0.375rem" }}>
        <legend
          style={{
            padding: 0,
            fontSize: "var(--text-2xs)",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--color-ink-soft)",
          }}
        >
          Motivo{exigido ? " (obligatorio)" : ""}
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
          {VARIANCE_REASONS.map((r) => (
            <button
              key={r.code}
              type="button"
              className={`ui-btn ${
                code === r.code ? "ui-btn--primary" : "ui-btn--secondary"
              }`}
              aria-pressed={code === r.code}
              disabled={disabled}
              onClick={() => onCode(code === r.code ? null : r.code)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </fieldset>

      <Field label="Detalle (opcional)">
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            describedBy={describedBy}
            rows={2}
            value={text}
            disabled={disabled}
            placeholder="Cliente frecuente, se le hizo el 10 %."
            onChange={(e) => onText(e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

/**
 * El renglón fuera de catálogo.
 *
 * Es la salida del retoque de garantía sin construir nada nuevo: monto en cero
 * más la nota, y la cita queda contada en ocupación y en la ficha de la
 * clienta. La nota la exige `lib/ticket.ts`, no este formulario — por eso acá
 * no hay validación propia: dejar que el error salga del motor evita dos
 * versiones de la misma regla.
 */
function RenglonManual({
  value,
  disabled,
  onChange,
  onRemove,
}: {
  value: { note: string; amount: number } | null;
  disabled: boolean;
  onChange: (next: { note: string; amount: number }) => void;
  onRemove: () => void;
}) {
  const current = value ?? { note: "", amount: 0 };

  return (
    <div
      style={{
        display: "grid",
        gap: "0.5rem",
        padding: "0.75rem",
        borderRadius: "var(--radius-md)",
        border: "1px dashed var(--hair-strong)",
        background: "var(--color-paper)",
      }}
    >
      <Field label="Qué se cobró" required>
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            describedBy={describedBy}
            rows={2}
            value={current.note}
            disabled={disabled}
            placeholder="Retoque de garantía: se repuso una uña."
            onChange={(e) => onChange({ ...current, note: e.target.value })}
          />
        )}
      </Field>

      <MoneyInput
        label="Monto"
        value={current.amount === 0 ? null : current.amount}
        disabled={disabled}
        max={99_999_999}
        hint="Cero es válido: es el retoque de garantía."
        onValueChange={(pesos) => onChange({ ...current, amount: pesos ?? 0 })}
      />

      <button
        type="button"
        className="ui-btn ui-btn--ghost"
        disabled={disabled}
        onClick={onRemove}
        style={{ justifySelf: "start" }}
      >
        Quitar este renglón
      </button>
    </div>
  );
}

function MetodoPago({
  value,
  disabled,
  onChange,
}: {
  value: PaymentMethod | null;
  disabled: boolean;
  onChange: (method: PaymentMethod | null) => void;
}) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0, display: "grid", gap: "0.375rem" }}>
      <legend
        style={{
          padding: 0,
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-ink-soft)",
        }}
      >
        Método de pago
      </legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m.method}
            type="button"
            className={`ui-btn ${value === m.method ? "ui-btn--primary" : "ui-btn--secondary"}`}
            aria-pressed={value === m.method}
            disabled={disabled}
            onClick={() => onChange(value === m.method ? null : m.method)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export { CambioTag };
