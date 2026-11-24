"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button, DateField, Field, MoneyInput, TextInput, formatCOP, useToast } from "@/components/ui";
import { DEPOSIT_STATE_LABEL } from "@/lib/deposits";

import {
  adelantosDeCita,
  borrarAdelanto,
  devolverAdelanto,
  pasarAdelanto,
  registrarAdelanto,
  type DepositActionResult,
} from "./actions";
import { METHOD_LABEL, type DepositView } from "./view";

type Method = "efectivo" | "transferencia" | "otro";
const METHODS: Method[] = ["transferencia", "efectivo", "otro"];

/** `YYYY-MM-DD` → "23 nov". */
function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function depositLine(deposit: DepositView): string {
  const parts = [
    `${formatCOP(deposit.amount)} · ${METHOD_LABEL[deposit.method]} · ${shortDay(deposit.paidOn)}`,
  ];
  if (deposit.refund) {
    parts.push(`devuelto ${formatCOP(deposit.refund.amount)} el ${shortDay(deposit.refund.on)}`);
  }
  return parts.join(" · ");
}

export function MethodChips({
  value,
  onChange,
  disabled,
  legend = "Cómo pagó",
}: {
  value: Method;
  onChange: (method: Method) => void;
  disabled: boolean;
  legend?: string;
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
        {legend}
      </legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
        {METHODS.map((method) => (
          <button
            key={method}
            type="button"
            className={`ui-btn ${value === method ? "ui-btn--primary" : "ui-btn--secondary"}`}
            aria-pressed={value === method}
            disabled={disabled}
            onClick={() => onChange(method)}
          >
            {METHOD_LABEL[method]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const formStyle = {
  display: "grid",
  gap: "0.625rem",
  paddingTop: "0.5rem",
  borderTop: "1px solid var(--hair)",
} as const;

/** Devolver un adelanto, todo o parte. */
export function RefundForm({
  deposit,
  today,
  onDone,
  onCancel,
}: {
  deposit: DepositView;
  today: string;
  onDone: (result: DepositActionResult) => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState<number | null>(deposit.remaining);
  const [method, setMethod] = useState<Method>(deposit.method);
  const [refundedOn, setRefundedOn] = useState(today);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function devolver() {
    if (amount === null || amount <= 0) {
      toast({ message: "Escribe cuánto se devolvió.", tone: "error" });
      return;
    }
    startTransition(async () => {
      const result = await devolverAdelanto({ depositId: deposit.id, amount, method, refundedOn, reason });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) onDone(result);
    });
  }

  return (
    <div style={formStyle}>
      <MoneyInput
        label="Monto devuelto"
        value={amount}
        max={deposit.amount}
        disabled={pending}
        hint={
          deposit.pushed
            ? "Ya está en Actual: esta noche sale como ajuste negativo."
            : "Todavía no llegó a Actual: viajan el adelanto y la devolución juntos."
        }
        onValueChange={setAmount}
      />
      <MethodChips value={method} onChange={setMethod} disabled={pending} legend="Por dónde salió" />
      <Field label="Día de la devolución">
        {({ id, describedBy }) => (
          <DateField
            id={id}
            describedBy={describedBy}
            value={refundedOn}
            min={deposit.paidOn}
            onChange={setRefundedOn}
            disabled={pending}
          />
        )}
      </Field>
      <Field label="Motivo" required>
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            describedBy={describedBy}
            value={reason}
            maxLength={500}
            disabled={pending}
            placeholder="Canceló con tiempo, la cuenta salió menor…"
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <Button variant="primary" loading={pending} loadingLabel="Guardando" onClick={devolver}>
          Devolver · {formatCOP(amount ?? 0)}
        </Button>
        <button type="button" className="ui-btn ui-btn--ghost" disabled={pending} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

type Loaded = Extract<Awaited<ReturnType<typeof adelantosDeCita>>, { ok: true }>;

/**
 * El bloque **Adelanto** del detalle de una cita en la agenda: lo que ya pagó,
 * registrar uno nuevo, devolverlo, o traer uno de otra cita de la misma
 * clienta (canceló y volvió a agendar).
 */
export function AdelantosCita({
  eaAppointmentId,
  today,
  readOnly,
}: {
  eaAppointmentId: number;
  today: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"none" | "add" | { refund: number }>("none");
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<Method>("transferencia");
  const [paidOn, setPaidOn] = useState(today);
  const [paidRef, setPaidRef] = useState("");
  const [pending, startTransition] = useTransition();

  // Cuántas veces se pidió leer: cada escritura suma una y el efecto vuelve a leer.
  const [version, setVersion] = useState(0);

  // Quien lo monta le pone `key` por cita: otra cita es otro bloque, sin restos.
  useEffect(() => {
    let vigente = true;
    adelantosDeCita(eaAppointmentId)
      .catch(() => ({ ok: false as const, message: "No se pudieron leer los adelantos." }))
      .then((result) => {
        if (!vigente) return;
        if (result.ok) {
          setData(result);
          setError(null);
        } else {
          setError(result.message);
        }
      });
    return () => {
      vigente = false;
    };
  }, [eaAppointmentId, version]);

  function done(result: DepositActionResult) {
    if (!result.ok) return;
    setForm("none");
    setAmount(null);
    setPaidRef("");
    setVersion((v) => v + 1);
    router.refresh();
  }

  function registrar() {
    if (amount === null || amount <= 0) {
      toast({ message: "Escribe el monto del adelanto.", tone: "error" });
      return;
    }
    startTransition(async () => {
      const result = await registrarAdelanto({ eaAppointmentId, amount, method, paidOn, paidRef });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      done(result);
    });
  }

  function borrar(deposit: DepositView) {
    if (!window.confirm(`¿Borrar el adelanto de ${formatCOP(deposit.amount)}? Úsalo solo si quedó mal escrito.`)) return;
    startTransition(async () => {
      const result = await borrarAdelanto(deposit.id);
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      done(result);
    });
  }

  function traer(deposit: DepositView) {
    if (!window.confirm(`¿Pasar el adelanto de ${formatCOP(deposit.remaining)} a esta cita?`)) return;
    startTransition(async () => {
      const result = await pasarAdelanto({ depositId: deposit.id, toEaAppointmentId: eaAppointmentId });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      done(result);
    });
  }

  if (error !== null) {
    return <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>{error}</p>;
  }
  if (data === null) {
    return <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>Revisando adelantos…</p>;
  }

  const disponible = data.deposits.reduce((sum, deposit) => sum + deposit.remaining, 0);
  const editable = !readOnly && !pending;

  return (
    <section style={{ display: "grid", gap: "0.5rem" }} aria-label="Adelanto">
      <p
        style={{
          margin: 0,
          display: "flex",
          justifyContent: "space-between",
          gap: "0.75rem",
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-ink-soft)",
        }}
      >
        <span>Adelanto</span>
        {disponible > 0 ? <span className="ui-num">{formatCOP(disponible)} por usar</span> : null}
      </p>

      {data.deposits.length === 0 ? (
        <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>Sin adelanto.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "0.375rem" }}>
          {data.deposits.map((deposit) => (
            <li key={deposit.id} style={{ display: "grid", gap: "0.25rem" }}>
              <span>
                {depositLine(deposit)}{" "}
                <span style={{ color: "var(--color-ink-soft)" }}>({DEPOSIT_STATE_LABEL[deposit.state]})</span>
              </span>
              {deposit.state === "pendiente" && deposit.refund === null && editable ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
                  {deposit.pushed && !data.canFixAfterSync ? null : (
                    <Button size="sm" variant="ghost" onClick={() => setForm({ refund: deposit.id })}>
                      Devolver
                    </Button>
                  )}
                  {deposit.pushed ? null : (
                    <Button size="sm" variant="ghost" onClick={() => borrar(deposit)}>
                      Borrar
                    </Button>
                  )}
                </span>
              ) : null}
              {typeof form === "object" && form.refund === deposit.id ? (
                <RefundForm deposit={deposit} today={today} onDone={done} onCancel={() => setForm("none")} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {data.movable.length > 0 && editable ? (
        <div style={{ display: "grid", gap: "0.375rem" }}>
          <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
            Esta clienta tiene un adelanto en otra cita sin cobrar:
          </p>
          {data.movable.map((deposit) => (
            <span key={deposit.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
              <span>
                {formatCOP(deposit.remaining)}
                {deposit.appointmentStart ? ` · cita del ${shortDay(deposit.appointmentStart.slice(0, 10))}` : ""}
              </span>
              <Button size="sm" variant="secondary" onClick={() => traer(deposit)}>
                Pasar a esta cita
              </Button>
            </span>
          ))}
        </div>
      ) : null}

      {form === "add" ? (
        <div style={formStyle}>
          <MoneyInput label="Monto del adelanto" value={amount} max={9_999_999} disabled={pending} onValueChange={setAmount} />
          <MethodChips value={method} onChange={setMethod} disabled={pending} />
          <Field label="Día del pago" hint="El día en que entró la plata: así lo encuentra el bot de finanzas.">
            {({ id, describedBy }) => (
              <DateField id={id} describedBy={describedBy} value={paidOn} onChange={setPaidOn} disabled={pending} />
            )}
          </Field>
          <Field label="Referencia (opcional)" hint="El número de la transferencia, si lo tienes.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                describedBy={describedBy}
                value={paidRef}
                maxLength={120}
                disabled={pending}
                onChange={(e) => setPaidRef(e.target.value)}
              />
            )}
          </Field>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            <Button variant="primary" loading={pending} loadingLabel="Guardando" onClick={registrar}>
              Registrar · {formatCOP(amount ?? 0)}
            </Button>
            <button type="button" className="ui-btn ui-btn--ghost" disabled={pending} onClick={() => setForm("none")}>
              Cancelar
            </button>
          </div>
        </div>
      ) : data.blocked === null && editable ? (
        <Button variant="secondary" onClick={() => setForm("add")} block>
          Registrar adelanto
        </Button>
      ) : null}
    </section>
  );
}
