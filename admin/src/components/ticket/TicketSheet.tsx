"use client";

import { useId, useMemo, useState, type ReactNode } from "react";

import {
  Button,
  Checkbox,
  Field,
  FormErrorSummary,
  Icon,
  MoneyInput,
  Panel,
  TextArea,
  formatCOP,
  formatPesos,
  formatTimeRange,
} from "@/components/ui";
import type { Cop, PaymentMethod } from "@/db/types";
import { composeFrom, findCombo, pairedServiceId, partnersFor, roleOf, type ComboComposition } from "@/lib/combos";
import type { PromoQuote } from "@/lib/promos";
import type { TicketPayment } from "@/lib/ticket";
import { ExtrasChips } from "./ExtrasChips";
import { CambioTag, ServicePicker } from "./ServicePicker";
import { findService, type CatalogService, type TicketCatalog } from "./catalog";
import {
  MAX_ADDITIONAL_SERVICES,
  NOTE_CHIPS,
  PAYMENT_METHODS,
  VARIANCE_REASONS,
  addService,
  appendNoteChip,
  bumpExtra,
  mergeIntoCombo,
  priceDraft,
  removeService,
  type TicketDraft,
  type TicketPricing,
} from "./draft";
import type { PendingTicket } from "./draft-store";
import type { FirstVisitStatus, TodayAppointment } from "./types";

/**
 * **Cerrar servicio** — la pantalla diseñada para un celular en una mano, entre
 * dos clientas. El escritorio es el caso raro, y por eso todo acá está pensado
 * a 390 px primero.
 *
 * Los seis pasos del plan, en orden, cada uno una sección con su número:
 *
 * 1. ¿Qué se hizo? — el agendado ya viene elegido; "¿también pies?" lo vuelve
 *    el combo, y "Agregar otro servicio" suma otro a su precio de lista
 * 2. Adicionales — chips con contador
 * 3. Total — grande, calculado, con la promo que le toque como su propio
 *    renglón (se quita y se vuelve a poner); tocarlo lo hace editable y abre el
 *    motivo
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
 * **No decide permisos.** `canCharge`, `canGiveCourtesy` y `readOnly` llegan
 * resueltos desde el servidor, y volver a comprobarlos en la Server Action no es redundancia sino
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
  canGiveCourtesy = false,
  courtesyFromDefault = false,
  readOnly = false,
  saving = false,
  dirty,
  pending,
  storageBlocked = false,
  combos = [],
  firstVisitStatus = null,
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
  /** `cortesia:otorgar` ya resuelto contra el rol: solo la dueña. */
  canGiveCourtesy?: boolean;
  /**
   * La casilla de cortesía llegó marcada **por la ficha de la clienta**, no por
   * alguien que la tocó. Se dice en pantalla para que quien cierra sepa que
   * puede desmarcarla: a veces esas mismas personas pagan.
   */
  courtesyFromDefault?: boolean;
  readOnly?: boolean;
  saving?: boolean;
  dirty: boolean;
  pending: PendingTicket | null;
  /** El navegador no deja escribir en `localStorage`. Se avisa, no se esconde. */
  storageBlocked?: boolean;
  /** Las composiciones de los combos, para "¿también pies?". Vacío = no se ofrece. */
  combos?: readonly ComboComposition[];
  /**
   * Lo que dijo el historial sobre si es su primera visita. `pendiente` mientras
   * se pregunta; `null` cuando no se preguntó (una cuenta ya guardada).
   */
  firstVisitStatus?: FirstVisitStatus | "pendiente" | null;
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

  const cortesia = draft.houseCourtesy;
  // Una cortesía que ya existe, abierta por quien no puede otorgarla: se mira,
  // no se toca. El servidor igual rechazaría guardarla (`cortesia:otorgar`), y
  // descubrirlo al tocar "Guardar" es tarde.
  const cortesiaAjena = cortesia && !canGiveCourtesy;
  const bloqueado = readOnly || saving || cortesiaAjena;
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
            {cortesia
              ? "Guardar · cortesía"
              : amountCharged === null
                ? "Guardar"
                : `Guardar · ${formatCOP(amountCharged)}`}
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
            La cuenta ya entró al cierre del día. Corregirla exige un ajuste y lo hace administración.
          </Aviso>
        ) : null}

        {cortesiaAjena ? (
          <Aviso tono="info">
            Esta cuenta es una <strong>cortesía de la casa</strong>: no se cobró y la profesional
            cobra su comisión sobre el precio de lista. Solo la dueña la puede cambiar.
          </Aviso>
        ) : !canGiveCourtesy && appointment.houseCourtesyDefault ? (
          <Aviso tono="info">
            {appointment.customerName} es <strong>cortesía de la casa</strong> en su ficha. Si hoy no
            paga, la cuenta la cierra la dueña como cortesía, para que tu comisión se calcule
            sobre el precio de lista.
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

          <ComboOffer
            catalog={catalog}
            combos={combos}
            performedId={draft.performedServiceId}
            bookedId={appointment.bookedServiceId}
            disabled={bloqueado}
            onChange={(performedServiceId) => patch({ performedServiceId })}
          />

          <ServiciosAgregados
            catalog={catalog}
            combos={combos}
            draft={draft}
            disabled={bloqueado}
            onDraftChange={onDraftChange}
          />
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
          {canGiveCourtesy ? (
            <CortesiaBlock
              checked={cortesia}
              fromDefault={courtesyFromDefault && cortesia}
              customerName={appointment.customerName}
              disabled={bloqueado}
              onChange={(on) => {
                setShowTotalEditor(false);
                patch(
                  on
                    ? {
                        houseCourtesy: true,
                        // Lo que una cortesía no puede traer se limpia al marcarla,
                        // no al guardar: el servidor lo rechazaría, y es mejor que
                        // la pantalla muestre de una vez la cuenta que se va a guardar.
                        totalOverride: null,
                        varianceReasonCode: null,
                        varianceReason: "",
                        payments: [],
                        tip: 0,
                      }
                    : { houseCourtesy: false },
                );
              }}
            />
          ) : null}

          {cortesia ? (
            <CortesiaTotal subtotal={subtotal} />
          ) : (
            <>
              <PromoBlock
                available={pricingResult.availablePromo}
                applied={pricingResult.promo}
                applyPromo={draft.applyPromo}
                overridden={draft.totalOverride !== null}
                firstVisit={draft.firstVisit}
                firstVisitStatus={firstVisitStatus}
                disabled={bloqueado}
                onApply={(applyPromo) => patch({ applyPromo })}
                onFirstVisit={(firstVisit) => patch({ firstVisit })}
              />

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
                  // La promo ya explica su descuento: no se le pide motivo.
                  exigido={descuento > 0 && pricingResult.varianceReasonCode !== "promo"}
                  disabled={bloqueado}
                  onCode={(varianceReasonCode) => patch({ varianceReasonCode })}
                  onText={(varianceReason) => patch({ varianceReason })}
                />
              ) : null}
            </>
          )}

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

          <Field label="Qué pasó" hint="Se guarda en el panel y aparece en la ficha de cliente.">
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
          {cortesia ? (
            <p style={{ margin: 0, color: "var(--color-ink-soft)" }}>
              Cortesía de la casa: no se registra método de pago ni propina, y la cuenta no entra a
              la caja del día.
            </p>
          ) : (
            <>
              {canCharge ? (
                <MetodoPago
                  payments={draft.payments}
                  amountCharged={amountCharged ?? 0}
                  disabled={bloqueado}
                  onChange={(payments) => patch({ payments })}
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
            </>
          )}
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
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)", textAlign: "right" }}>
        {descuento > 0 && subtotal !== null ? (
          <>
            Lista <s className="ui-num">{formatCOP(subtotal)}</s> · toca para cambiarlo
          </>
        ) : (
          "Toca para cambiarlo"
        )}
      </span>
    </button>
  );
}

/**
 * "¿También pies?" — el par que es un combo se cobra **como el combo**.
 *
 * Es la misma composición que la agenda (`lib/combos.ts`): se elige la mitad
 * que se hizo, la hoja ofrece la otra mitad que forma un combo, y al tocarla el
 * servicio realizado pasa a ser el combo, con el precio que fijó la dueña. Solo
 * se ofrece lo que existe: un par sin combo se agrega abajo, como otro servicio.
 */
function ComboOffer({
  catalog,
  combos,
  performedId,
  bookedId,
  disabled,
  onChange,
}: {
  catalog: TicketCatalog;
  combos: readonly ComboComposition[];
  performedId: number | null;
  /** El servicio agendado: deshacer el combo vuelve a él si es una de sus mitades. */
  bookedId: number | null;
  disabled: boolean;
  onChange: (eaServiceId: number) => void;
}) {
  const { baseId, composed } = composeFrom(combos, performedId, null);

  if (composed !== null) {
    const hands = findService(catalog, composed.handsEaServiceId);
    const feet = findService(catalog, composed.feetEaServiceId);
    if (hands === null || feet === null) return null;
    // Deshacer el combo vuelve a la mitad que se agendó: una cita de pies a la
    // que se le sumaron manos vuelve a pies, no a manos. Si se agendó otra cosa
    // (el combo mismo, otro servicio), queda la mitad de manos.
    const solo = bookedId === feet.eaServiceId ? feet : hands;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem" }}>
        <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          Combo: <strong>{hands.name}</strong> + <strong>{feet.name}</strong>
        </span>
        <button
          type="button"
          className="ui-btn ui-btn--ghost"
          disabled={disabled}
          onClick={() => onChange(solo.eaServiceId)}
        >
          Solo {solo.name}
        </button>
      </div>
    );
  }

  const partners = partnersFor(combos, baseId)
    .map((id) => {
      const partner = findService(catalog, id);
      const combo = findCombo(combos, baseId, id);
      const whole = combo === null ? null : findService(catalog, combo.eaServiceId);
      return partner === null || whole === null ? null : { partner, whole };
    })
    .filter((p): p is { partner: CatalogService; whole: CatalogService } => p !== null);

  if (partners.length === 0) return null;

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
        {roleOf(combos, baseId) === "feet" ? "¿También manos?" : "¿También pies?"}
      </legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
        {partners.map(({ partner, whole }) => (
          <button
            key={partner.eaServiceId}
            type="button"
            className="ui-btn ui-btn--secondary"
            disabled={disabled}
            onClick={() => onChange(pairedServiceId(combos, baseId, partner.eaServiceId) ?? partner.eaServiceId)}
          >
            <Icon name="mas-signo" size={14} /> {partner.name}
            {whole.listPrice === null ? "" : ` · combo ${formatCOP(whole.listPrice)}`}
          </button>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
        Se cobra como el combo, con el precio de la dueña.
      </p>
    </fieldset>
  );
}

/**
 * **Agregar otro servicio**: lo que se hizo además del principal y no forma un
 * combo publicado (rubber en manos + pies, mientras la dueña no le ponga precio
 * al par). Cada uno va a su precio de lista y comisiona como el principal.
 *
 * Si el agregado **sí** forma un combo con el principal, se ofrece cobrarlo
 * como el combo: es el precio que corresponde, y cobrar la suma sería cobrar de
 * más.
 */
function ServiciosAgregados({
  catalog,
  combos,
  draft,
  disabled,
  onDraftChange,
}: {
  catalog: TicketCatalog;
  combos: readonly ComboComposition[];
  draft: TicketDraft;
  disabled: boolean;
  onDraftChange: (next: TicketDraft) => void;
}) {
  const [adding, setAdding] = useState(false);
  const main = findService(catalog, draft.performedServiceId);

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {draft.additionalServices.map((id, index) => {
        const service = findService(catalog, id);
        const combo = findCombo(combos, draft.performedServiceId, id);
        const whole = combo === null ? null : findService(catalog, combo.eaServiceId);
        return (
          <div
            key={`${id}-${index}`}
            style={{
              display: "grid",
              gap: "0.375rem",
              padding: "0.5rem 0.75rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--hair-strong)",
              background: "var(--color-paper)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600 }}>
                  + {service?.name ?? `Servicio #${id}`}
                </span>
                <span style={{ display: "block", fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
                  Otro servicio · a su precio de lista
                </span>
              </span>
              <span className="ui-num">
                {service?.listPrice == null ? "sin precio" : formatCOP(service.listPrice)}
              </span>
              <button
                type="button"
                className="ui-btn ui-btn--ghost"
                disabled={disabled}
                aria-label={`Quitar ${service?.name ?? "servicio"}`}
                onClick={() => onDraftChange(removeService(draft, index))}
              >
                Quitar
              </button>
            </div>
            {combo !== null && whole !== null ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem" }}>
                <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
                  Con {main?.name ?? "el principal"} es el combo <strong>{whole.name}</strong>
                  {whole.listPrice === null ? "" : ` (${formatCOP(whole.listPrice)})`}.
                </span>
                <button
                  type="button"
                  className="ui-btn ui-btn--secondary"
                  disabled={disabled}
                  onClick={() => onDraftChange(mergeIntoCombo(draft, index, combo.eaServiceId))}
                >
                  Cobrar como combo
                </button>
              </div>
            ) : null}
          </div>
        );
      })}

      {adding ? (
        <div style={{ display: "grid", gap: "0.375rem" }}>
          <ServicePicker
            catalog={catalog}
            value={null}
            bookedServiceId={null}
            disabled={disabled}
            defaultOpen
            emptyLabel="Elige el otro servicio"
            emptyHint="Se cobra a su precio de lista"
            groupLabel="Otro servicio"
            onChange={(eaServiceId) => {
              onDraftChange(addService(draft, eaServiceId));
              setAdding(false);
            }}
          />
          <button
            type="button"
            className="ui-btn ui-btn--ghost"
            disabled={disabled}
            onClick={() => setAdding(false)}
            style={{ justifySelf: "start" }}
          >
            Cancelar
          </button>
        </div>
      ) : draft.additionalServices.length < MAX_ADDITIONAL_SERVICES ? (
        <button
          type="button"
          className="ui-btn ui-btn--ghost"
          disabled={disabled}
          onClick={() => setAdding(true)}
          style={{ justifySelf: "start" }}
        >
          <Icon name="mas-signo" size={16} /> Agregar otro servicio
        </button>
      ) : null}
    </div>
  );
}

/**
 * La promo, **como su propio renglón**: "Promo · Miércoles de pies −$15.000".
 *
 * El monto sale de `priceDraft()` —la misma cuenta que hará el servidor—, se
 * recalcula solo cuando cambia el servicio o se agrega otro, y se puede quitar
 * y volver a poner. Debajo, la casilla de primera visita: la marca el
 * historial cuando se pudo leer, y si no, la técnica. Las promos no se acumulan;
 * la hoja lo dice en vez de dejar que alguien espere las dos.
 */
function PromoBlock({
  available,
  applied,
  applyPromo,
  overridden,
  firstVisit,
  firstVisitStatus,
  disabled,
  onApply,
  onFirstVisit,
}: {
  available: PromoQuote | null;
  applied: PromoQuote | null;
  applyPromo: boolean;
  overridden: boolean;
  firstVisit: boolean;
  firstVisitStatus: FirstVisitStatus | "pendiente" | null;
  disabled: boolean;
  onApply: (on: boolean) => void;
  onFirstVisit: (on: boolean) => void;
}) {
  const hint =
    firstVisitStatus === "pendiente"
      ? "Revisando el historial…"
      : firstVisitStatus === "primera"
        ? "Según el historial, es su primera vez en el estudio."
        : firstVisitStatus === "recurrente"
          ? "Según el historial, ya vino antes."
          : firstVisitStatus === "desconocido"
            ? "No se pudo revisar todo el historial: márcala solo si sabes que es su primera vez."
            : "Márcala si es su primera vez en el estudio.";

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {applied !== null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.5rem 0.75rem",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-gold-dark)",
            background: "var(--color-gold-pale)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>Promo · {applied.label}</span>
          <span className="ui-num" style={{ fontWeight: 600 }}>
            −{formatCOP(applied.discount)}
          </span>
          <button
            type="button"
            className="ui-btn ui-btn--ghost"
            disabled={disabled}
            onClick={() => onApply(false)}
          >
            Quitar
          </button>
        </div>
      ) : available !== null && !applyPromo ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            Le aplica <strong>{available.label}</strong> (−{formatCOP(available.discount)}).
          </span>
          <button
            type="button"
            className="ui-btn ui-btn--secondary"
            disabled={disabled}
            onClick={() => onApply(true)}
          >
            Aplicar promo
          </button>
        </div>
      ) : available !== null && overridden ? (
        <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          La promo {available.label} (−{formatCOP(available.discount)}) no se suma a un total escrito a
          mano. Vuelve al calculado para aplicarla.
        </p>
      ) : null}

      <Checkbox
        label={
          <>
            <strong>Primera visita</strong> — 10 % en los servicios
          </>
        }
        hint={
          firstVisit && available !== null && available.kind === "dia"
            ? `${hint} No se acumula con la promo del día: queda la mayor.`
            : hint
        }
        checked={firstVisit}
        disabled={disabled}
        onChange={(e) => onFirstVisit(e.target.checked)}
      />
    </div>
  );
}

/**
 * La casilla de **cortesía de la casa**. Solo se dibuja para quien la puede
 * otorgar (la dueña).
 *
 * Cuando llegó marcada por la ficha de la clienta se dice con todas las letras,
 * con el nombre adentro: la casilla pre-marcada es la forma más fácil de regalar
 * un servicio sin querer, y las mismas personas a veces pagan.
 */
function CortesiaBlock({
  checked,
  fromDefault,
  customerName,
  disabled,
  onChange,
}: {
  checked: boolean;
  fromDefault: boolean;
  customerName: string;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: "0.375rem",
        padding: "0.625rem 0.75rem",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${checked ? "var(--color-info-line)" : "var(--hair-strong)"}`,
        background: checked ? "var(--color-info-tint)" : "var(--color-paper)",
      }}
    >
      <Checkbox
        label={
          <>
            <strong>Cortesía de la casa</strong> — no se cobra, la profesional sí cobra su comisión
          </>
        }
        hint="Cobro en cero, fuera de la caja del día. La comisión se calcula sobre el precio de lista."
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {fromDefault ? (
        <p
          role="status"
          style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-info-ink)" }}
        >
          <strong>Marcada por defecto</strong>: {customerName} es cortesía de la casa en su ficha.
          Si esta vez paga, desmárcala.
        </p>
      ) : null}
    </div>
  );
}

/** El total de una cortesía: cero, con el precio de lista que paga la comisión debajo. */
function CortesiaTotal({ subtotal }: { subtotal: number | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "0.75rem",
        minHeight: "var(--hit)",
        padding: "0.625rem 0.875rem",
        background: "var(--color-cream)",
        border: "1px solid var(--hair-strong)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <span
        className="ui-num"
        style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--color-carbon)" }}
      >
        {formatCOP(0)}
      </span>
      <span style={{ fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)", textAlign: "right" }}>
        {subtotal === null
          ? "Cortesía de la casa"
          : `Precio de lista ${formatCOP(subtotal)} · base de la comisión`}
      </span>
    </div>
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
  payments,
  amountCharged,
  disabled,
  onChange,
}: {
  payments: readonly TicketPayment[];
  amountCharged: Cop;
  disabled: boolean;
  onChange: (payments: TicketPayment[]) => void;
}) {
  const selected = payments.map((payment) => payment.method);
  const dividido = payments.length > 1;

  /**
   * Tocar un método.
   *
   * Con ninguno seleccionado, lo elige. Con ése ya elegido, lo suelta. Con otro
   * ya elegido, **lo agrega**: es el caso de la cuenta partida, y llegar a él
   * tiene que costar un toque, no un menú escondido — pasa lo suficiente como
   * para que esconderlo signifique que alguien va a mentir en el método.
   *
   * Al agregar el segundo, el primero se queda con lo que ya tenía escrito (o
   * con todo lo cobrado, si venía solo) y el segundo arranca con el resto. Es
   * la repartición que la persona iba a escribir de todos modos.
   */
  function toggle(method: PaymentMethod): void {
    const existing = payments.find((payment) => payment.method === method);

    if (existing) {
      onChange(payments.filter((payment) => payment.method !== method));
      return;
    }

    if (payments.length === 0) {
      onChange([{ method, amount: amountCharged }]);
      return;
    }

    const asignado = payments.reduce(
      (sum, payment, index) => sum + (index === 0 && payments.length === 1 ? amountCharged : payment.amount),
      0,
    );
    const resto = Math.max(amountCharged - asignado, 0);

    onChange([
      ...payments.map((payment, index) =>
        index === 0 && payments.length === 1
          ? { ...payment, amount: amountCharged }
          : payment,
      ),
      { method, amount: resto },
    ]);
  }

  function setAmount(method: PaymentMethod, amount: Cop): void {
    onChange(
      payments.map((payment) => (payment.method === method ? { ...payment, amount } : payment)),
    );
  }

  const asignado = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const falta = amountCharged - asignado;

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
            className={`ui-btn ${selected.includes(m.method) ? "ui-btn--primary" : "ui-btn--secondary"}`}
            aria-pressed={selected.includes(m.method)}
            disabled={disabled}
            onClick={() => toggle(m.method)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {dividido && (
        <>
          {payments.map((payment) => (
            <MoneyInput
              key={payment.method}
              label={PAYMENT_METHODS.find((m) => m.method === payment.method)?.label ?? payment.method}
              value={payment.amount === 0 ? null : payment.amount}
              disabled={disabled}
              max={9_999_999}
              onValueChange={(pesos) => setAmount(payment.method, pesos ?? 0)}
            />
          ))}

          {/*
            La cifra que falta —o que sobra— se dice acá y no al guardar. El
            servidor igual rechaza una cuenta que no cuadra, pero descubrirlo al
            tocar "Guardar", con la clienta esperando, es tarde.
          */}
          <p
            style={{
              margin: 0,
              fontSize: "var(--text-2xs)",
              color: falta === 0 ? "var(--color-ink-soft)" : "var(--color-alerta)",
            }}
          >
            {falta === 0
              ? "Los dos montos suman lo cobrado."
              : falta > 0
                ? `Faltan ${formatPesos(falta)} por asignar.`
                : `Sobran ${formatPesos(-falta)}: los montos suman más que la cuenta.`}
          </p>
        </>
      )}
    </fieldset>
  );
}

export { CambioTag };
