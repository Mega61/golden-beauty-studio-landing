"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import { LazyMotion, MotionConfig, domAnimation, m } from "motion/react";
import type { Dictionary, Locale } from "../dictionaries";
import { trackEvent, trackMeta } from "@/lib/analytics";
import { fill, formatCOP, formatPhoneInput, isPlausiblePhone } from "@/lib/booking";
import { newEventId } from "@/lib/meta-events";
import {
  GIFT_MESSAGE_MAX,
  GIFT_NAME_MAX,
  GIFT_RECIPIENT_MAX,
  cleanRef,
  giftOrderErrors,
  parseTiers,
  tierKey,
  whatsappSendLink,
  type GiftOrderField,
  type GiftOrderResult,
  type GiftTier,
} from "@/lib/gift";
import { FALLBACK_GIFT_TIERS, isFallbackTier } from "@/data/gift-tiers";
import GiftCardVisual, { toneFor } from "./GiftCardVisual";

type Dict = Dictionary["regalar"];

type Reason = keyof Dict["errors"];

/**
 * The tier picker, the order form and the confirmation — the only part of
 * `/regalar` that ships JavaScript.
 *
 * ## What it never does
 *
 * **Never sends an amount.** The order carries the tier id; the panel looks
 * the price up in Stampee. The amount on screen is for the buyer's eyes only.
 *
 * **Never puts a price in WhatsApp.** The pay message is the code, nothing
 * else: it's a chat the studio reads, and a screenshot someone may forward.
 *
 * ## When the panel is down
 *
 * The bundled tiers still render (a page of blank cards sells nothing), but
 * they can't be ordered — their ids aren't Stampee's. The submit button turns
 * into "order on WhatsApp", naming the tier and no price.
 */
export default function RegalarFlow({
  dict,
  lang,
  initialTiers,
  whatsappNumber,
  paymentInfo,
  turnstileSiteKey,
}: {
  dict: Dict;
  lang: Locale;
  /** Rendered with the page; null when the server couldn't reach the panel. */
  initialTiers: GiftTier[] | null;
  whatsappNumber: string | null;
  /** `NEXT_PUBLIC_GIFT_PAYMENT_INFO`, split into lines. Null = sent on WhatsApp. */
  paymentInfo: string[] | null;
  turnstileSiteKey: string | null;
}) {
  const [tiers, setTiers] = useState<readonly GiftTier[]>(initialTiers ?? FALLBACK_GIFT_TIERS);
  const [live, setLive] = useState(initialTiers !== null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ buyerName: "", buyerPhone: "", recipientName: "", message: "" });
  const [touched, setTouched] = useState<Partial<Record<GiftOrderField, boolean>>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<Reason | null>(null);
  const [sending, setSending] = useState(false);
  const [order, setOrder] = useState<(GiftOrderResult & { tone: number; to: string }) | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const formPanelRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  /** When the form first rendered. The proxy rejects instant submissions. */
  const startedAt = useRef(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // The server render couldn't reach the panel: try once from the browser.
  // A cold panel answering a second later is the common case.
  useEffect(() => {
    if (initialTiers !== null) return;
    let cancelled = false;
    fetch("/api/regalos/tiers", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        const fresh = parseTiers(body);
        if (cancelled || fresh.length === 0) return;
        setTiers(fresh);
        setLive(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initialTiers]);

  const selected = tiers.find((t) => t.id === selectedId) ?? null;
  const selectedIndex = selected ? tiers.indexOf(selected) : 1;
  const canOrderOnline = live && selected !== null && !isFallbackTier(selected.id);

  const errors = giftOrderErrors({ ...form, tierId: selectedId ?? "" }, isPlausiblePhone);
  const invalid = (f: GiftOrderField): boolean => errors.includes(f) && (showErrors || touched[f] === true);

  const coversFor = (tier: GiftTier) => {
    const known = (dict.tiers.covers as Record<string, string>)[tierKey(tier.name)];
    // Spanish: Stampee's own text wins, so the owner can reword it without a
    // deploy. English: the dictionary, since Stampee only speaks Spanish.
    if (lang === "es") return tier.description || known || "";
    return known || tier.description;
  };
  const monthsOf = (days: number) => String(Math.max(1, Math.round(days / 30.4)));

  const choose = (tier: GiftTier) => {
    setSelectedId(tier.id);
    setError(null);
    trackEvent("gift_select_tier", { tier: tier.name, value: tier.amountCop, currency: "COP" });
    // Bring the form into view, unless it already is (desktop, short screens).
    const panel = formPanelRef.current;
    if (panel && panel.getBoundingClientRect().top > window.innerHeight * 0.6) {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const resetTurnstile = () => {
    try {
      (window as unknown as { turnstile?: { reset: () => void } }).turnstile?.reset();
    } catch {
      // Widget not loaded: nothing to reset.
    }
  };

  const submit = async () => {
    setShowErrors(true);
    setError(null);
    if (!selected || !canOrderOnline) return;
    if (errors.length > 0) {
      setError(errors.includes("buyerPhone") && errors.length === 1 ? "phone" : "validation");
      return;
    }

    // Meta: the order is the checkout. Same id as the server copy the proxy
    // sends when the panel accepts it, so Meta counts one.
    const eventId = newEventId("gift");
    trackMeta(
      "InitiateCheckout",
      {
        currency: "COP",
        value: selected.amountCop,
        content_type: "product",
        content_ids: [`tarjeta-regalo-${tierKey(selected.name)}`],
        content_category: "gift_card",
      },
      eventId,
    );
    trackEvent("gift_order_submit", { tier: selected.name, value: selected.amountCop, currency: "COP" });

    const token = formRef.current?.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value;

    setSending(true);
    try {
      const res = await fetch("/api/regalos", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          tierId: selected.id,
          buyerName: form.buyerName,
          buyerPhone: form.buyerPhone,
          recipientName: form.recipientName,
          message: form.message,
          // `?ref=` from the link she came in on (`adviento`, a campaign…),
          // read at submit time so the page itself can stay static.
          ref: cleanRef(new URLSearchParams(window.location.search).get("ref")),
          eventId,
          startedAt: startedAt.current,
          empresa: honeypotRef.current?.value ?? "",
          "cf-turnstile-response": token ?? "",
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; order: GiftOrderResult }
        | { ok: false; reason?: string }
        | null;

      if (res.status === 201 && body && body.ok) {
        setOrder({ ...body.order, tone: selectedIndex, to: form.recipientName.trim() });
        trackEvent("gift_order_created", { tier: selected.name, value: selected.amountCop, currency: "COP" });
        requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
      }

      const reason = (body && !body.ok && body.reason) || "unavailable";
      setError(reason in dict.errors ? (reason as Reason) : "unavailable");
      trackEvent("gift_order_error", { reason });
      if (reason === "taken") {
        // The tier went away under her: reload the list and clear the choice.
        setSelectedId(null);
        fetch("/api/regalos/tiers")
          .then((r) => (r.ok ? r.json() : null))
          .then((b: unknown) => {
            const fresh = parseTiers(b);
            if (fresh.length) setTiers(fresh);
          })
          .catch(() => {});
      }
      resetTurnstile();
    } catch {
      setError("unavailable");
      resetTurnstile();
    } finally {
      setSending(false);
    }
  };

  const again = () => {
    setOrder(null);
    setSelectedId(null);
    setForm((f) => ({ ...f, recipientName: "", message: "" }));
    setShowErrors(false);
    setTouched({});
    requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const previewTo = form.recipientName.trim() || dict.card.someone;

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        {turnstileSiteKey && !order && (
          <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="lazyOnload" />
        )}

        <section
          ref={sectionRef}
          id="tarjetas"
          aria-labelledby="regalar-tiers-title"
          className="relative bg-ivory px-5 py-16 md:px-14 md:py-24"
          style={{ scrollMarginTop: 80 }}
        >
          <div className="mx-auto max-w-[1180px]">
            {order ? (
              <Success
                dict={dict}
                lang={lang}
                order={order}
                whatsappNumber={whatsappNumber}
                paymentInfo={paymentInfo}
                onAgain={again}
              />
            ) : (
              <>
                {/* ── Tiers ─────────────────────────────────────────────── */}
                <div className="mb-10 md:mb-14 md:grid md:grid-cols-2 md:items-end md:gap-14">
                  <div>
                    <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.32em] text-gold">
                      {dict.tiers.eyebrow}
                    </span>
                    <h2
                      id="regalar-tiers-title"
                      className="m-0 mt-3.5 font-display text-[38px] font-normal leading-[1.02] text-ink md:text-[56px]"
                      style={{ letterSpacing: "-0.02em" }}
                    >
                      {dict.tiers.title1}{" "}
                      <em className="text-gold-grad not-italic">
                        <span className="italic">{dict.tiers.title2_em}</span>
                      </em>
                    </h2>
                  </div>
                  <p className="mt-4 max-w-[460px] font-sans text-[14px] leading-[1.65] text-ink-soft md:mt-0 md:text-[15px]">
                    {dict.tiers.body}
                  </p>
                </div>

                <div role="radiogroup" aria-labelledby="regalar-tiers-title" className="grid gap-5 md:grid-cols-3 md:gap-6">
                  {tiers.map((tier, i) => {
                    const on = tier.id === selectedId;
                    return (
                      <m.button
                        key={tier.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => choose(tier)}
                        whileTap={{ scale: 0.985 }}
                        className={`group flex flex-col rounded-[26px] border p-4 text-left transition-[border-color,box-shadow,transform] duration-300 md:p-5 ${
                          on
                            ? "border-gold bg-paper shadow-[0_30px_60px_-34px_rgba(139,106,31,0.75)] md:-translate-y-1"
                            : "border-ink/10 bg-paper/70 hover:border-gold/50 hover:bg-paper"
                        }`}
                      >
                        <GiftCardVisual
                          tone={toneFor(i)}
                          size="sm"
                          label={dict.card.label}
                          tierName={tier.name}
                          amount={formatCOP(tier.amountCop, lang)}
                          className="transition-transform duration-500 group-hover:-rotate-[1.2deg] group-hover:scale-[1.012]"
                        />
                        <div className="flex flex-1 flex-col px-1 pt-5">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="font-display text-[28px] leading-none text-ink">{tier.name}</span>
                            <span className="font-sans text-[15px] font-semibold tabular-nums text-gold-dark">
                              {formatCOP(tier.amountCop, lang)}
                            </span>
                          </div>
                          <p className="mt-2.5 font-sans text-[14px] leading-[1.55] text-ink-soft">{coversFor(tier)}</p>
                          <p className="mt-1.5 font-sans text-[12px] text-ink-mute">
                            {fill(dict.tiers.validity, { months: monthsOf(tier.validityDays) })}
                          </p>
                          <span
                            className={`mt-5 flex items-center justify-center gap-2 rounded-full px-5 py-3 font-sans text-[12px] font-semibold uppercase tracking-[0.2em] transition-colors ${
                              on ? "bg-gold-grad text-white" : "border border-ink/15 text-ink group-hover:border-gold"
                            }`}
                          >
                            {on ? <CheckIcon /> : null}
                            {on ? dict.tiers.chosen : dict.tiers.choose}
                          </span>
                        </div>
                      </m.button>
                    );
                  })}
                </div>

                {/* ── Form ──────────────────────────────────────────────── */}
                <div
                  ref={formPanelRef}
                  className="mx-auto mt-14 grid max-w-[1040px] overflow-hidden rounded-[28px] border border-ink/8 bg-paper shadow-[0_40px_90px_-50px_rgba(28,23,20,0.45)] md:mt-20 md:grid-cols-[0.95fr_1.05fr]"
                  style={{ scrollMarginTop: 90 }}
                >
                  {/* Live preview: the card fills in as she types. */}
                  <div className="relative flex flex-col justify-center overflow-hidden bg-carbon px-6 py-9 md:px-10 md:py-12">
                    <span aria-hidden className="bg-marble pointer-events-none absolute inset-0" style={{ opacity: 0.07 }} />
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2"
                      style={{ background: "radial-gradient(circle, rgba(231,170,81,0.22) 0%, rgba(231,170,81,0) 60%)" }}
                    />
                    <p className="relative m-0 font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
                      {dict.form.eyebrow}
                    </p>
                    <div className="relative mx-auto mt-6 w-full max-w-[400px]">
                      <GiftCardVisual
                        tone={toneFor(selectedIndex)}
                        label={dict.card.label}
                        tierName={selected?.name}
                        amount={selected ? formatCOP(selected.amountCop, lang) : "$ —"}
                        toLabel={dict.card.to}
                        toName={previewTo}
                      />
                    </div>
                    {form.message.trim() && (
                      <p className="relative mx-auto mt-6 max-w-[360px] text-center font-display text-[19px] italic leading-snug text-cream/85">
                        “{form.message.trim()}”
                      </p>
                    )}
                    <p className="relative mx-auto mt-6 max-w-[360px] text-center font-sans text-[12.5px] leading-relaxed text-cream/60">
                      {dict.form.payNote}
                    </p>
                  </div>

                  <form
                    ref={formRef}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submit();
                    }}
                    noValidate
                    className="relative grid content-start gap-5 px-5 py-8 md:px-10 md:py-12"
                  >
                    {/* Honeypot: off-screen, not display:none (bots skip those). */}
                    <div aria-hidden style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
                      <label htmlFor="regalo-empresa">Empresa</label>
                      <input id="regalo-empresa" type="text" name="empresa" tabIndex={-1} autoComplete="off" ref={honeypotRef} />
                    </div>

                    <h3 className="m-0 font-display text-[30px] font-normal leading-tight text-ink md:text-[34px]">{dict.form.title}</h3>

                    {/* Chosen tier, or the nudge to choose one. */}
                    <div
                      className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${
                        showErrors && !selected ? "border-red-700/50 bg-red-50/40" : "border-ink/10 bg-ivory/60"
                      }`}
                    >
                      {selected ? (
                        <>
                          <span className="min-w-0">
                            <span className="block font-sans text-[10px] font-semibold uppercase tracking-[0.24em] text-ink-mute">
                              {dict.form.tier}
                            </span>
                            <span className="mt-0.5 block truncate font-display text-[21px] leading-tight text-ink">
                              {selected.name} <span className="font-sans text-[14px] tabular-nums text-gold-dark">· {formatCOP(selected.amountCop, lang)}</span>
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                            className="shrink-0 font-sans text-[13px] text-gold-dark underline decoration-gold/40 underline-offset-4 hover:decoration-gold"
                          >
                            {dict.form.change}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                          className={`font-sans text-[14px] ${showErrors ? "text-red-800" : "text-ink-soft"}`}
                        >
                          ↑ {dict.form.pickTier}
                        </button>
                      )}
                    </div>

                    <TextField
                      id="g-buyer"
                      label={dict.form.buyerName}
                      value={form.buyerName}
                      onChange={(v) => setForm({ ...form, buyerName: v })}
                      onBlur={() => setTouched((t) => ({ ...t, buyerName: true }))}
                      invalid={invalid("buyerName")}
                      autoComplete="name"
                      maxLength={GIFT_NAME_MAX}
                    />

                    <div>
                      <label htmlFor="g-phone" className={LABEL}>
                        {dict.form.buyerPhone}
                      </label>
                      <div
                        className={`flex items-stretch overflow-hidden rounded-xl border bg-paper transition-colors focus-within:border-gold ${
                          invalid("buyerPhone") ? "border-red-700/50" : "border-ink/15"
                        }`}
                      >
                        {!form.buyerPhone.trim().startsWith("+") && (
                          <span className="flex items-center whitespace-nowrap border-r border-ink/10 bg-ivory-deep/50 px-3.5 font-sans text-[15px] tabular-nums text-ink-soft">
                            +57
                          </span>
                        )}
                        <input
                          id="g-phone"
                          type="tel"
                          inputMode="tel"
                          autoComplete="tel-national"
                          value={form.buyerPhone}
                          onChange={(e) => setForm({ ...form, buyerPhone: formatPhoneInput(e.target.value) })}
                          onBlur={() => setTouched((t) => ({ ...t, buyerPhone: true }))}
                          aria-invalid={invalid("buyerPhone")}
                          aria-describedby="g-phone-hint"
                          placeholder="300 123 4567"
                          className="w-full bg-transparent px-4 py-3.5 font-sans text-[16px] tabular-nums text-ink outline-none placeholder:text-ink/25"
                        />
                      </div>
                      <p id="g-phone-hint" className={`mt-1.5 font-sans text-xs ${invalid("buyerPhone") ? "text-red-800" : "text-ink-mute"}`}>
                        {invalid("buyerPhone") ? dict.form.phoneInvalid : dict.form.phoneHint}
                      </p>
                    </div>

                    <TextField
                      id="g-to"
                      label={dict.form.recipient}
                      optional={dict.form.optional}
                      value={form.recipientName}
                      onChange={(v) => setForm({ ...form, recipientName: v })}
                      onBlur={() => setTouched((t) => ({ ...t, recipientName: true }))}
                      invalid={invalid("recipientName")}
                      placeholder={dict.form.recipientPlaceholder}
                      hint={dict.form.recipientHint}
                      maxLength={GIFT_RECIPIENT_MAX}
                      autoComplete="off"
                    />

                    <div>
                      <label htmlFor="g-msg" className={LABEL}>
                        {dict.form.message} <span className="font-normal normal-case tracking-normal text-ink-mute/80">· {dict.form.optional}</span>
                      </label>
                      <textarea
                        id="g-msg"
                        rows={2}
                        maxLength={GIFT_MESSAGE_MAX}
                        value={form.message}
                        placeholder={dict.form.messagePlaceholder}
                        onChange={(e) => setForm({ ...form, message: e.target.value.replace(/\n/g, " ") })}
                        aria-describedby="g-msg-count"
                        className="w-full resize-none rounded-xl border border-ink/15 bg-paper px-4 py-3 font-sans text-[16px] text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-gold"
                      />
                      <p id="g-msg-count" className="mt-1 text-right font-sans text-[11px] tabular-nums text-ink-mute">
                        {form.message.length}/{GIFT_MESSAGE_MAX}
                      </p>
                    </div>

                    {turnstileSiteKey && (
                      <div className="cf-turnstile" data-sitekey={turnstileSiteKey} data-theme="light" data-size="flexible" data-language={lang} />
                    )}

                    {error && (
                      <p role="alert" className="m-0 rounded-xl bg-red-50 px-4 py-3 font-sans text-[13px] leading-relaxed text-red-900">
                        {dict.errors[error]}
                      </p>
                    )}

                    {live || !selected ? (
                      <button
                        type="submit"
                        disabled={sending}
                        className="mt-1 flex items-center justify-center gap-2.5 rounded-full bg-carbon px-6 py-4 font-sans text-[13px] font-semibold uppercase tracking-[0.22em] text-gold-soft transition-opacity disabled:opacity-70"
                      >
                        {sending ? <Spinner /> : null}
                        {sending ? dict.form.sending : dict.form.submit}
                        {!sending && <span className="font-serif text-base leading-none">→</span>}
                      </button>
                    ) : (
                      // Panel unreachable: the bundled tiers can't be ordered.
                      <div className="mt-1 grid gap-3">
                        <p className="m-0 font-sans text-[13px] leading-relaxed text-ink-soft">{dict.form.fallbackNote}</p>
                        {whatsappNumber && (
                          <a
                            href={whatsappSendLink(whatsappNumber, fill(dict.form.fallbackText, { tier: selected.name }))}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => trackEvent("gift_order_whatsapp", { tier: selected.name })}
                            className="flex items-center justify-center gap-2.5 rounded-full bg-carbon px-6 py-4 font-sans text-[13px] font-semibold text-gold-soft"
                          >
                            <WaIcon /> {dict.form.fallbackCta}
                          </a>
                        )}
                      </div>
                    )}
                  </form>
                </div>
              </>
            )}
          </div>
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}

const LABEL = "mb-1.5 block font-sans text-[11px] font-semibold uppercase tracking-[0.2em] text-ink-mute";

function TextField({
  id,
  label,
  optional,
  value,
  onChange,
  onBlur,
  invalid,
  hint,
  ...rest
}: {
  id: string;
  label: string;
  optional?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  invalid: boolean;
  hint?: string;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
        {optional ? <span className="font-normal normal-case tracking-normal text-ink-mute/80"> · {optional}</span> : null}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={invalid}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`w-full rounded-xl border bg-paper px-4 py-3.5 font-sans text-[16px] text-ink outline-none transition-colors placeholder:text-ink/25 focus:border-gold ${
          invalid ? "border-red-700/50" : "border-ink/15"
        }`}
        {...rest}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 font-sans text-xs text-ink-mute">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Success({
  dict,
  lang,
  order,
  whatsappNumber,
  paymentInfo,
  onAgain,
}: {
  dict: Dict;
  lang: Locale;
  order: GiftOrderResult & { tone: number; to: string };
  whatsappNumber: string | null;
  paymentInfo: string[] | null;
  onAgain: () => void;
}) {
  const t = dict.success;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(order.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (in-app browsers): the code is on screen to copy by hand.
    }
  };

  return (
    <div className="mx-auto grid max-w-[1040px] items-start gap-10 md:grid-cols-[1fr_1fr] md:gap-14">
      <div className="md:sticky md:top-28">
        <m.div
          initial={{ opacity: 0, y: 24, rotate: -6, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, rotate: -2.5, scale: 1 }}
          transition={{ type: "spring", stiffness: 140, damping: 16 }}
          className="mx-auto w-full max-w-[460px]"
        >
          <GiftCardVisual
            tone={toneFor(order.tone)}
            label={dict.card.label}
            tierName={order.tierName || undefined}
            amount={formatCOP(order.amountCop, lang)}
            toLabel={dict.card.to}
            toName={order.to || dict.card.someone}
            code={order.code}
          />
        </m.div>
      </div>

      <div>
        <p className="m-0 font-sans text-[11px] font-semibold uppercase tracking-[0.32em] text-gold-dark">{t.eyebrow}</p>
        <h2 className="m-0 mt-2 font-display text-[44px] font-normal leading-none text-ink md:text-[56px]" style={{ letterSpacing: "-0.02em" }}>
          {t.title}
        </h2>
        <p className="mt-4 font-sans text-[15px] leading-relaxed text-ink-soft">
          {fill(t.body, { tier: order.tierName || dict.card.label.toLowerCase() })}
        </p>

        {/* The code: what she'll quote on WhatsApp and the studio will look up. */}
        <div className="mt-7 flex items-center justify-between gap-3 rounded-2xl border border-gold/40 bg-paper px-5 py-4">
          <span className="min-w-0">
            <span className="block font-sans text-[10px] font-semibold uppercase tracking-[0.26em] text-ink-mute">{t.code}</span>
            <span className="mt-1 block font-sans text-[22px] font-semibold tabular-nums tracking-[0.12em] text-ink md:text-[24px]">
              {order.code}
            </span>
          </span>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-full border border-ink/15 px-4 py-2 font-sans text-[12px] text-ink transition-colors hover:border-gold"
            aria-live="polite"
          >
            {copied ? t.copied : t.copy}
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-2xl border border-ink/10 bg-paper">
          <div className="flex items-baseline justify-between gap-3 bg-carbon px-5 py-4">
            <p className="m-0 font-display text-[22px] leading-tight text-cream">{t.payTitle}</p>
            {order.amountCop > 0 && (
              <p className="m-0 font-sans text-[13px] text-gold-soft">
                {t.amount} <span className="font-display text-[22px] tabular-nums text-cream">{formatCOP(order.amountCop, lang)}</span>
              </p>
            )}
          </div>
          <div className="px-5 py-4 font-sans text-[14px] leading-relaxed text-ink">
            {paymentInfo ? (
              <ul className="m-0 grid list-none gap-1 p-0">
                {paymentInfo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="m-0">{t.payFallback}</p>
            )}
            <p className="m-0 mt-3 text-[13px] text-ink-soft">{t.payThen}</p>
          </div>
        </div>

        {whatsappNumber && (
          <a
            href={whatsappSendLink(whatsappNumber, fill(t.whatsappText, { code: order.code }))}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackEvent("gift_pay_whatsapp")}
            className="mt-5 flex items-center justify-center gap-2.5 rounded-full bg-carbon px-6 py-4 text-center font-sans text-[13px] font-semibold text-gold-soft"
          >
            <span className="text-whatsapp">
              <WaIcon />
            </span>
            {t.whatsappCta}
          </a>
        )}

        <a
          href={order.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackEvent("gift_view_card")}
          className="mt-3 flex items-center justify-between gap-3 rounded-full border border-ink/15 bg-paper px-6 py-3.5 font-sans text-[13px] text-ink transition-colors hover:border-gold"
        >
          <span>{t.cardLink}</span>
          <span className="text-gold-dark">↗</span>
        </a>
        <p className="mt-2 px-1 font-sans text-[12px] text-ink-mute">{t.cardHint}</p>

        <button
          type="button"
          onClick={onAgain}
          className="mt-8 font-sans text-[13px] text-ink-mute underline decoration-ink/20 underline-offset-4 hover:text-ink"
        >
          {t.again}
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-gold-soft/30 border-t-gold-soft" />;
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function WaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.8.9-.9 1.1-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4s1 2.8 1.2 3c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4c-1-1.6-1.5-3.4-1.5-5.2 0-5.4 4.4-9.8 9.8-9.8 2.6 0 5.1 1 6.9 2.9 1.8 1.8 2.9 4.3 2.9 6.9 0 5.4-4.4 9.8-9.8 9.8zm8.3-18.1C18.1 1.5 15.1.3 12 .3 5.5.3.3 5.5.3 12c0 2.1.5 4.1 1.6 5.9L.2 23.7l6-1.6c1.7.9 3.7 1.4 5.7 1.4 6.5 0 11.7-5.2 11.7-11.7 0-3.1-1.2-6.1-3.4-8.3z" />
    </svg>
  );
}
