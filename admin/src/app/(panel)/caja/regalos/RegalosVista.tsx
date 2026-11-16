"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  Button,
  Card,
  CardHead,
  DateField,
  EmptyState,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Select,
  TextArea,
  TextInput,
  formatCOP,
  useToast,
} from "@/components/ui";
import { WhatsAppLink } from "@/components/ui/WhatsAppLink";
import { GIFT_PAYMENT_LABEL } from "@/lib/gift-cards";

import { openWhatsappAfter } from "../../recordatorios/open-whatsapp";
import {
  anularVentaRegalo,
  confirmarPagoRegalo,
  descartarPedidoRegalo,
  enlaceCompradoraRegalo,
  venderRegaloEnEstudio,
  type GiftActionResult,
} from "./actions";
import type { GiftCardRow, GiftSaleRow, RegalosView } from "./data";

type Method = "efectivo" | "transferencia" | "otro";
const METHODS: Method[] = ["transferencia", "efectivo", "otro"];

/**
 * **Tarjetas regalo** — lo que el estudio hace con la plata de las tarjetas:
 * confirmar el pago de los pedidos de la página, vender una en el mostrador y
 * mandársela a la compradora por WhatsApp. Lo demás (montos, diseño, la lista
 * completa) es de Stampee; usar una tarjeta es cobrar la cuenta desde Hoy.
 *
 * Lo pendiente va arriba: es lo único que pide hacer algo.
 */
export function RegalosVista({ view, canFixAfterSync }: { view: RegalosView; canFixAfterSync: boolean }) {
  const salesByCard = new Map(view.sales.map((sale) => [sale.cardId, sale]));
  const [sellOpen, setSellOpen] = useState(false);
  const [done, setDone] = useState<{ code: string; message: string; whatsapp: string | null } | null>(null);

  const onDone = (result: GiftActionResult) => {
    if (result.ok) setDone({ code: result.code, message: result.message, whatsapp: result.whatsapp });
  };

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        <p style={{ margin: 0, flex: "1 1 16rem", fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
          Una venta confirmada acá es ingreso del día del pago y llega sola a Actual esta noche. La tarjeta se usa
          al cobrar la cuenta en <Link href="/hoy">Hoy</Link>. Los montos y el diseño se manejan en Stampee.
        </p>
        <Button variant="primary" icon="mas-signo" onClick={() => setSellOpen(true)} disabled={view.tiers.length === 0}>
          Vender en el estudio
        </Button>
      </div>

      {view.stampeeProblem !== null ? (
        <div role="status" className="ui-callout ui-callout--warn">
          <Icon name="alerta" size={18} />
          <span>{view.stampeeProblem} Las ventas ya registradas se ven abajo.</span>
        </div>
      ) : null}

      {done !== null ? <Confirmada done={done} onClose={() => setDone(null)} /> : null}

      <Pedidos cards={view.pending} today={view.today} onDone={onDone} />

      <Activas cards={view.active} salesByCard={salesByCard} canFixAfterSync={canFixAfterSync} />

      <Usadas cards={view.redeemed} />

      <VentaEstudio open={sellOpen} tiers={view.tiers} onClose={() => setSellOpen(false)} onDone={onDone} />
    </div>
  );
}

/** Después de confirmar: el botón para mandarle la tarjeta a la compradora. */
function Confirmada({
  done,
  onClose,
}: {
  done: { code: string; message: string; whatsapp: string | null };
  onClose: () => void;
}) {
  return (
    <Card>
      <div style={{ display: "grid", gap: "0.625rem" }}>
        <p style={{ margin: 0, display: "flex", gap: "0.5rem", alignItems: "center", fontWeight: 600 }}>
          <Icon name="check" size={18} /> {done.message}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {done.whatsapp !== null ? (
            <a className="ui-btn ui-btn--primary" href={done.whatsapp} target="_blank" rel="noopener noreferrer">
              <Icon name="whatsapp" size={16} /> Enviar al comprador por WhatsApp
            </a>
          ) : (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
              No hay celular de la compradora o link de la tarjeta para mandarla por WhatsApp.
            </span>
          )}
          <button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </Card>
  );
}

// ── Pedidos por confirmar ───────────────────────────────────────────────────

function Pedidos({
  cards,
  today,
  onDone,
}: {
  cards: readonly GiftCardRow[];
  today: string;
  onDone: (result: GiftActionResult) => void;
}) {
  return (
    <Card padded={false}>
      <CardHead title={cards.length === 0 ? "Pedidos por confirmar" : `${cards.length} por confirmar`} />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.75rem" }}>
        {cards.length === 0 ? (
          <EmptyState
            icon="regalo"
            title="No hay pedidos esperando pago"
            body="Los pedidos de la página /regalar llegan acá. Cuando entre la transferencia, confírmala y se activa la tarjeta."
          />
        ) : (
          cards.map((card) => <Pedido key={card.id} card={card} today={today} onDone={onDone} />)
        )}
      </div>
    </Card>
  );
}

function Pedido({
  card,
  today,
  onDone,
}: {
  card: GiftCardRow;
  today: string;
  onDone: (result: GiftActionResult) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [abierto, setAbierto] = useState(false);
  const [method, setMethod] = useState<Method>("transferencia");
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState<number | null>(card.amountCop);
  const [paidRef, setPaidRef] = useState("");
  const [pending, startTransition] = useTransition();

  function confirmar() {
    if (amount === null || amount <= 0) {
      toast({ message: "Escribe el monto que entró.", tone: "error" });
      return;
    }
    startTransition(async () => {
      const result = await confirmarPagoRegalo({ cardId: card.id, method, paidOn, amount, paidRef });
      if (!result.ok) {
        toast({ message: result.message, tone: "error" });
        return;
      }
      toast({ message: result.message, tone: "ok" });
      onDone(result);
      setAbierto(false);
      router.refresh();
    });
  }

  function descartar() {
    if (!window.confirm(`¿Descartar el pedido ${card.code}? La tarjeta queda anulada.`)) return;
    startTransition(async () => {
      const result = await descartarPedidoRegalo(card.id);
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gap: "0.5rem",
        padding: "0.75rem",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--hair-strong)",
        background: "var(--color-paper)",
      }}
    >
      <CardLine card={card} />
      {card.buyerPhone ? (
        <div>
          <WhatsAppLink phone={card.buyerPhone} customerName={card.buyerName} />
        </div>
      ) : null}

      {abierto ? (
        <div style={{ display: "grid", gap: "0.625rem", paddingTop: "0.5rem", borderTop: "1px solid var(--hair)" }}>
          <MethodChips value={method} onChange={setMethod} disabled={pending} />
          <Field label="Día del pago" hint="El día en que entró la plata: es el día de caja de la venta.">
            {({ id, describedBy }) => (
              <DateField id={id} describedBy={describedBy} value={paidOn} onChange={setPaidOn} disabled={pending} />
            )}
          </Field>
          <MoneyInput
            label="Monto recibido"
            value={amount}
            max={9_999_999}
            disabled={pending}
            hint={amount !== card.amountCop ? `La tarjeta es de ${formatCOP(card.amountCop)}.` : undefined}
            onValueChange={setAmount}
          />
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
            <Button variant="primary" loading={pending} loadingLabel="Confirmando" onClick={confirmar}>
              Confirmar pago · {formatCOP(amount ?? 0)}
            </Button>
            <button type="button" className="ui-btn ui-btn--ghost" disabled={pending} onClick={() => setAbierto(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <Button variant="primary" size="sm" onClick={() => setAbierto(true)} disabled={pending}>
            Confirmar pago
          </Button>
          <Button variant="ghost" size="sm" onClick={descartar} loading={pending}>
            Descartar
          </Button>
        </div>
      )}
    </div>
  );
}

function MethodChips({
  value,
  onChange,
  disabled,
}: {
  value: Method;
  onChange: (method: Method) => void;
  disabled: boolean;
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
        Cómo pagó
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
            {GIFT_PAYMENT_LABEL[method]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Código, monto, quién compra y para quién. */
function CardLine({ card, extra }: { card: GiftCardRow; extra?: string | null }) {
  const para = card.recipientName ? `para ${card.recipientName}` : "sin destinataria todavía";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 0.75rem", alignItems: "baseline" }}>
      <span className="ui-num" style={{ fontWeight: 600 }}>
        {card.code}
      </span>
      <span style={{ fontWeight: 600 }}>{formatCOP(card.amountCop)}</span>
      {card.tierName ? <span style={{ color: "var(--color-ink-soft)" }}>{card.tierName}</span> : null}
      <span style={{ flexBasis: "100%", fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
        {card.funded ? `De ${card.buyerName ?? "—"} · ${para}` : `Promocional (${sourceLabel(card.source)}) · ${para}`}
        {extra ? ` · ${extra}` : ""}
      </span>
    </div>
  );
}

function sourceLabel(source: GiftCardRow["source"]): string {
  return source === "advent" ? "adviento" : source === "manual" ? "emitida en Stampee" : "venta";
}

// ── Activas ─────────────────────────────────────────────────────────────────

function Activas({
  cards,
  salesByCard,
  canFixAfterSync,
}: {
  cards: readonly GiftCardRow[];
  salesByCard: ReadonlyMap<string, GiftSaleRow>;
  canFixAfterSync: boolean;
}) {
  return (
    <Card padded={false}>
      <CardHead title={cards.length === 0 ? "Activas" : `${cards.length} activas`} />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.5rem" }}>
        {cards.length === 0 ? (
          <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--color-ink-soft)" }}>
            Ninguna tarjeta activa por ahora.
          </p>
        ) : (
          cards.map((card) => (
            <Activa key={card.id} card={card} sale={salesByCard.get(card.id) ?? null} canFixAfterSync={canFixAfterSync} />
          ))
        )}
      </div>
    </Card>
  );
}

function Activa({
  card,
  sale,
  canFixAfterSync,
}: {
  card: GiftCardRow;
  sale: GiftSaleRow | null;
  canFixAfterSync: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const vence = card.effectiveStatus === "expired" ? "vencida" : card.validTo ? `vence ${card.validTo}` : null;
  const venta =
    sale === null
      ? null
      : `${GIFT_PAYMENT_LABEL[sale.method]} el ${sale.paidOn} · ${sale.pushed ? "en Actual" : "llega a Actual esta noche"}`;
  const puedeAnular = sale !== null && !sale.voided && (!sale.pushed || canFixAfterSync);

  function reenviar() {
    const opening = openWhatsappAfter(() => enlaceCompradoraRegalo(card.id));
    startTransition(async () => {
      try {
        const { result, opened } = await opening;
        if (!result.ok) toast({ message: result.message, tone: "error" });
        else if (!opened) toast({ message: "El navegador no dejó abrir WhatsApp. Toca de nuevo.", tone: "error" });
      } catch {
        toast({ message: "No se pudo preparar el mensaje. Intenta de nuevo.", tone: "error" });
      }
    });
  }

  function anular() {
    if (sale === null) return;
    const reason = window.prompt(
      sale.pushed
        ? `Anular la venta de ${card.code}. Ya está en Actual: esta noche sale un ajuste negativo. ¿Por qué se anula?`
        : `Anular la venta de ${card.code}. ¿Por qué se anula?`,
    );
    if (reason === null || reason.trim().length < 3) return;
    startTransition(async () => {
      const result = await anularVentaRegalo({ saleId: sale.id, reason });
      toast({ message: result.message, tone: result.ok ? "ok" : "error" });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gap: "0.375rem",
        padding: "0.625rem 0",
        borderBottom: "1px solid var(--hair)",
      }}
    >
      <CardLine card={card} extra={[vence, venta].filter(Boolean).join(" · ") || null} />
      {card.funded ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          <Button variant="secondary" size="sm" icon="whatsapp" loading={pending} onClick={reenviar}>
            Reenviar a la compradora
          </Button>
          {puedeAnular ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={anular}>
              Anular venta
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Usadas ──────────────────────────────────────────────────────────────────

function Usadas({ cards }: { cards: readonly GiftCardRow[] }) {
  if (cards.length === 0) return null;
  return (
    <Card padded={false}>
      <CardHead title="Usadas hace poco" />
      <div style={{ padding: "0 1rem 1rem", display: "grid", gap: "0.375rem" }}>
        {cards.map((card) => (
          <CardLine
            key={card.id}
            card={card}
            extra={card.redeemedAt ? `usada el ${card.redeemedAt.slice(0, 10)}` : "usada"}
          />
        ))}
      </div>
    </Card>
  );
}

// ── Vender en el estudio ────────────────────────────────────────────────────

function VentaEstudio({
  open,
  tiers,
  onClose,
  onDone,
}: {
  open: boolean;
  tiers: RegalosView["tiers"];
  onClose: () => void;
  onDone: (result: GiftActionResult) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [tierId, setTierId] = useState(tiers[0]?.id ?? "");
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [method, setMethod] = useState<Method>("efectivo");
  const [pending, startTransition] = useTransition();
  const tier = tiers.find((t) => t.id === tierId) ?? null;

  function vender() {
    startTransition(async () => {
      const result = await venderRegaloEnEstudio({
        tierId,
        buyerName,
        buyerPhone,
        recipientName: recipientName || undefined,
        message: message || undefined,
        method,
      });
      if (!result.ok) {
        toast({ message: result.message, tone: "error" });
        return;
      }
      toast({ message: result.message, tone: "ok" });
      onDone(result);
      setBuyerName("");
      setBuyerPhone("");
      setRecipientName("");
      setMessage("");
      onClose();
      router.refresh();
    });
  }

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Vender una tarjeta regalo"
      dismissable={!pending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            block
            loading={pending}
            loadingLabel="Vendiendo"
            disabled={tier === null || buyerName.trim().length < 2 || buyerPhone.trim() === ""}
            onClick={vender}
          >
            {tier === null ? "Elige el monto" : `Cobrar ${formatCOP(tier.amountCop)}`}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: "0.875rem" }}>
        <Field label="Tarjeta">
          {({ id, describedBy }) => (
            <Select id={id} describedBy={describedBy} value={tierId} disabled={pending} onChange={(e) => setTierId(e.target.value)}>
              {tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {formatCOP(t.amountCop)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Quién la compra" required>
          {({ id, describedBy }) => (
            <TextInput id={id} describedBy={describedBy} value={buyerName} maxLength={80} disabled={pending} onChange={(e) => setBuyerName(e.target.value)} />
          )}
        </Field>
        <Field label="Su celular" required hint="Ahí le llega la tarjeta por WhatsApp.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              value={buyerPhone}
              inputMode="tel"
              autoComplete="off"
              maxLength={30}
              disabled={pending}
              onChange={(e) => setBuyerPhone(e.target.value)}
            />
          )}
        </Field>
        <Field label="Para quién (opcional)" hint="Si no lo sabe, la persona lo escribe después en el link.">
          {({ id, describedBy }) => (
            <TextInput id={id} describedBy={describedBy} value={recipientName} maxLength={40} disabled={pending} onChange={(e) => setRecipientName(e.target.value)} />
          )}
        </Field>
        <Field label="Mensaje (opcional)">
          {({ id, describedBy }) => (
            <TextArea id={id} describedBy={describedBy} rows={2} value={message} maxLength={140} disabled={pending} onChange={(e) => setMessage(e.target.value)} />
          )}
        </Field>
        <MethodChips value={method} onChange={setMethod} disabled={pending} />
        <p style={{ margin: 0, fontSize: "var(--text-2xs)", color: "var(--color-ink-soft)" }}>
          Al cobrar, la tarjeta queda activa por un año y la venta llega a Actual esta noche.
        </p>
      </div>
    </Panel>
  );
}
